import { NextRequest, NextResponse } from "next/server";

interface TokenBucket {
	tokens: number;
	lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

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
}

function getClientIp(request: NextRequest): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		request.headers.get("x-real-ip") ||
		"unknown"
	);
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
	const ip = getClientIp(request);
	const key = `write:${ip}`;
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
