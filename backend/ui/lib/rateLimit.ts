import { NextRequest, NextResponse } from "next/server";
import { emailHeader } from "./runtime";

interface TokenBucket {
	tokens: number;
	lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();
const maxBuckets = 20000;

// Cleanup stale buckets every 5 minutes
const cleanupInterval = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(): void {
	const now = Date.now();
	if (now - lastCleanup < cleanupInterval) return;
	lastCleanup = now;
	const staleThreshold = now - 60 * 1000;
	for (const [key, bucket] of buckets) {
		if (bucket.lastRefill < staleThreshold) {
			buckets.delete(key);
		}
	}

	// A burst of distinct subjects between two sweeps grows this without bound
	// otherwise. Oldest first, and a dropped bucket only ever means a full
	// allowance, which the sweep above would have given anyway.
	if (buckets.size > maxBuckets) {
		const byAge = Array.from(buckets.entries()).sort(
			(a, b) => a[1].lastRefill - b[1].lastRefill,
		);
		for (const [key] of byAge.slice(0, buckets.size - maxBuckets)) {
			buckets.delete(key);
		}
	}
}

// Who to charge a request to.
//
// The forwarded identity first, because that is the thing being limited and it
// survives a proxy that rewrites addresses or puts a whole office behind one.
// An address is the fallback, and the constant is the last resort: without this
// order a deployment whose proxy sets no address header put every caller in one
// bucket, and thirty writes a minute became the limit for the whole
// installation rather than for one person.
function limitSubject(request: NextRequest): string {
	const forwardedUser = request.headers.get(emailHeader);
	if (forwardedUser) return `u:${forwardedUser.toLowerCase()}`;

	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		request.headers.get("x-real-ip");
	return ip ? `ip:${ip}` : "anonymous";
}

function checkLimit(
	key: string,
	maxTokens: number,
	refillRate: number,
): { allowed: boolean; retryAfter: number } {
	cleanup();

	const now = Date.now();
	let bucket = buckets.get(key);

	if (!bucket) {
		bucket = { tokens: maxTokens - 1, lastRefill: now };
		buckets.set(key, bucket);
		return { allowed: true, retryAfter: 0 };
	}

	// Refill tokens based on elapsed time
	const elapsed = (now - bucket.lastRefill) / 1000;
	bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
	bucket.lastRefill = now;

	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return { allowed: true, retryAfter: 0 };
	}

	const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate);
	return { allowed: false, retryAfter };
}

// 30 write requests per minute (0.5 tokens/second)
export function checkWriteRateLimit(request: NextRequest): NextResponse | null {
	const key = `write:${limitSubject(request)}`;
	const { allowed, retryAfter } = checkLimit(key, 30, 0.5);

	if (!allowed) {
		return NextResponse.json(
			{ success: false, error: "Too many requests. Try again later." },
			{
				status: 429,
				headers: { "Retry-After": String(retryAfter) },
			},
		);
	}
	return null;
}
