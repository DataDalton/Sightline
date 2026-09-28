import {
	createECDH,
	createCipheriv,
	createHmac,
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";

// Web Push, written against the two standards it is made of rather than
// through a library: RFC 8291 encrypts the message so only the browser that
// subscribed can read it, and RFC 8292 (VAPID) signs the request so the push
// service knows which server is sending. Both are a few HMACs and one cipher
// call, which node:crypto has.
//
// Nothing here touches the database or the network except send(), so the
// encryption can be checked against the worked example in the RFC.

export interface PushSubscriptionKeys {
	// The browser's public key, uncompressed P-256, base64url.
	p256dh: string;
	// The browser's authentication secret, sixteen bytes, base64url.
	auth: string;
}

export interface VapidKeys {
	// Uncompressed P-256 public key, base64url. Handed to the browser when it
	// subscribes, and sent with every push so the service can check the
	// signature against the key the subscription was made with.
	publicKey: string;
	// The private scalar, base64url.
	privateKey: string;
	// A contact the push service can reach about this sender: a mailto: or
	// https: address. Some services refuse a request without one.
	subject: string;
}

export function b64url(bytes: Buffer | Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Buffer {
	return Buffer.from(text, "base64url");
}

function hmac(key: Buffer, data: Buffer): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

// HKDF with a single block of output, which is all either derivation needs.
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
	const prk = hmac(salt, ikm);
	return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(
		0,
		length,
	);
}

// The size of the one record a message is sent as. Larger than any payload
// this sends, so the record is always the last one.
const recordSize = 4096;

export interface EncryptOptions {
	// Fixed only by a test reproducing the RFC example. Random otherwise, and
	// must be, since reusing either with the same keys breaks the cipher.
	salt?: Buffer;
	senderPrivateKey?: Buffer;
}

// RFC 8291: the body a push service carries to the browser.
export function encryptPayload(
	keys: PushSubscriptionKeys,
	plaintext: Buffer,
	options: EncryptOptions = {},
): Buffer {
	const receiverPublic = fromB64url(keys.p256dh);
	const authSecret = fromB64url(keys.auth);
	if (receiverPublic.length !== 65 || receiverPublic[0] !== 4) {
		throw new Error("The subscription key is not a P-256 public key.");
	}
	if (authSecret.length < 16) {
		throw new Error("The subscription secret is too short.");
	}

	const sender = createECDH("prime256v1");
	if (options.senderPrivateKey)
		sender.setPrivateKey(options.senderPrivateKey);
	else sender.generateKeys();
	const senderPublic = sender.getPublicKey();
	const shared = sender.computeSecret(receiverPublic);

	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info\0", "latin1"),
		receiverPublic,
		senderPublic,
	]);
	const ikm = hkdf(authSecret, shared, keyInfo, 32);

	const salt = options.salt ?? randomBytes(16);
	const cek = hkdf(
		salt,
		ikm,
		Buffer.from("Content-Encoding: aes128gcm\0", "latin1"),
		16,
	);
	const nonce = hkdf(
		salt,
		ikm,
		Buffer.from("Content-Encoding: nonce\0", "latin1"),
		12,
	);

	// One record, so it carries the last-record delimiter and no padding.
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const sealed = Buffer.concat([
		cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
		cipher.final(),
		cipher.getAuthTag(),
	]);

	const header = Buffer.alloc(16 + 4 + 1);
	salt.copy(header, 0);
	header.writeUInt32BE(recordSize, 16);
	header.writeUInt8(senderPublic.length, 20);
	return Buffer.concat([header, senderPublic, sealed]);
}

// RFC 8292: the Authorization header for one push service.
//
// The audience is the service's origin, so a signature made for one service is
// refused by every other. Valid for twelve hours, well inside the day the
// standard allows.
export function vapidAuthorization(
	endpoint: string,
	vapid: VapidKeys,
	nowSeconds = Math.floor(Date.now() / 1000),
): string {
	const audience = new URL(endpoint).origin;
	const header = b64url(
		Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
	);
	const claims = b64url(
		Buffer.from(
			JSON.stringify({
				aud: audience,
				exp: nowSeconds + 12 * 60 * 60,
				sub: vapid.subject,
			}),
		),
	);
	const signingInput = `${header}.${claims}`;

	const publicKey = fromB64url(vapid.publicKey);
	const key = createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			d: vapid.privateKey,
			x: b64url(publicKey.subarray(1, 33)),
			y: b64url(publicKey.subarray(33, 65)),
		},
		format: "jwk",
	});
	// JOSE wants the raw r and s pair rather than the DER structure node
	// produces by default.
	const signature = sign("sha256", Buffer.from(signingInput), {
		key,
		dsaEncoding: "ieee-p1363",
	});

	return `vapid t=${signingInput}.${b64url(signature)}, k=${vapid.publicKey}`;
}

export function generateVapidKeys(subject: string): VapidKeys {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	const jwk = privateKey.export({ format: "jwk" });
	const pub = publicKey.export({ format: "jwk" });
	const raw = Buffer.concat([
		Buffer.from([4]),
		fromB64url(pub.x as string),
		fromB64url(pub.y as string),
	]);
	return {
		publicKey: b64url(raw),
		privateKey: jwk.d as string,
		subject,
	};
}

export interface PushTarget {
	endpoint: string;
	keys: PushSubscriptionKeys;
}

export type SendOutcome =
	// Accepted by the push service. Delivery to the device is its business.
	| { kind: "sent" }
	// The subscription no longer exists, and should be forgotten.
	| { kind: "gone"; status: number }
	// Anything else, worth trying again later.
	| { kind: "failed"; status: number | null; message: string };

// Only the push services browsers actually use. A subscription endpoint comes
// from the browser, and posting to an address a client supplied is how a
// server gets used to reach inside its own network, so anything else is
// refused before a request is made.
const pushHosts = [
	/(^|\.)googleapis\.com$/,
	/(^|\.)push\.services\.mozilla\.com$/,
	/(^|\.)push\.apple\.com$/,
	/(^|\.)notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			pushHosts.some((p) => p.test(url.hostname))
		);
	} catch {
		return false;
	}
}

export async function send(
	target: PushTarget,
	payload: unknown,
	vapid: VapidKeys,
	urgency: "normal" | "high" = "normal",
): Promise<SendOutcome> {
	if (!isPushEndpoint(target.endpoint)) {
		return {
			kind: "gone",
			status: 0,
		};
	}

	let body: Buffer;
	try {
		body = encryptPayload(
			target.keys,
			Buffer.from(JSON.stringify(payload), "utf8"),
		);
	} catch (error) {
		// A subscription whose keys cannot be used never will be.
		return { kind: "gone", status: 0 };
	}

	try {
		const response = await fetch(target.endpoint, {
			method: "POST",
			headers: {
				Authorization: vapidAuthorization(target.endpoint, vapid),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				// Held for a day if the device is off. Anything older is not
				// worth arriving.
				TTL: String(24 * 60 * 60),
				Urgency: urgency,
			},
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(15000),
		});
		if (response.status >= 200 && response.status < 300) {
			return { kind: "sent" };
		}
		if (response.status === 404 || response.status === 410) {
			return { kind: "gone", status: response.status };
		}
		const text = await response.text().catch(() => "");
		return {
			kind: "failed",
			status: response.status,
			message: text.slice(0, 300) || response.statusText,
		};
	} catch (error) {
		return {
			kind: "failed",
			status: null,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
