import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createDecipheriv,
	createECDH,
	createHmac,
	createPublicKey,
	verify,
} from "node:crypto";
import {
	b64url,
	encryptPayload,
	fitPayload,
	fromB64url,
	generateVapidKeys,
	isPushEndpoint,
	payloadBudget,
	vapidAuthorization,
} from "./webPush";

// The worked example in RFC 8291, appendix A.
const example = {
	plaintext: "When I grow up, I want to be a watermelon",
	senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	receiverPublic:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encrypts the RFC 8291 example byte for byte", () => {
	const body = encryptPayload(
		{ p256dh: example.receiverPublic, auth: example.auth },
		Buffer.from(example.plaintext),
		{
			salt: fromB64url(example.salt),
			senderPrivateKey: fromB64url(example.senderPrivate),
		},
	);
	assert.equal(b64url(body), example.body);
});

// What a browser does on receipt, written out so a random salt and key can be
// checked too.
function decrypt(body: Buffer, receiverPrivate: Buffer, auth: Buffer) {
	const salt = body.subarray(0, 16);
	const idLength = body.readUInt8(20);
	const senderPublic = body.subarray(21, 21 + idLength);
	const sealed = body.subarray(21 + idLength);

	const receiver = createECDH("prime256v1");
	receiver.setPrivateKey(receiverPrivate);
	const shared = receiver.computeSecret(senderPublic);
	const h = (k: Buffer, d: Buffer) =>
		createHmac("sha256", k).update(d).digest();
	const expand = (s: Buffer, ikm: Buffer, info: string | Buffer, n: number) =>
		h(
			h(s, ikm),
			Buffer.concat([
				typeof info === "string" ? Buffer.from(info, "latin1") : info,
				Buffer.from([1]),
			]),
		).subarray(0, n);

	const ikm = expand(
		auth,
		shared,
		Buffer.concat([
			Buffer.from("WebPush: info\0", "latin1"),
			receiver.getPublicKey(),
			senderPublic,
		]),
		32,
	);
	const cek = expand(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
	const nonce = expand(salt, ikm, "Content-Encoding: nonce\0", 12);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const out = Buffer.concat([
		decipher.update(sealed.subarray(0, sealed.length - 16)),
		decipher.final(),
	]);
	assert.equal(out[out.length - 1], 2, "last record delimiter");
	return out.subarray(0, out.length - 1).toString("utf8");
}

test("a fresh salt and key still decrypt to the message", () => {
	const receiver = createECDH("prime256v1");
	receiver.generateKeys();
	const auth = Buffer.alloc(16, 7);
	const message = JSON.stringify({ title: "Revenue is above target" });
	const body = encryptPayload(
		{ p256dh: b64url(receiver.getPublicKey()), auth: b64url(auth) },
		Buffer.from(message),
	);
	assert.equal(decrypt(body, receiver.getPrivateKey(), auth), message);
});

test("refuses a key that is not a P-256 point", () => {
	assert.throws(() =>
		encryptPayload(
			{
				p256dh: b64url(Buffer.alloc(10)),
				auth: b64url(Buffer.alloc(16)),
			},
			Buffer.from("x"),
		),
	);
});

test("signs a VAPID token the public key verifies, for the endpoint origin", () => {
	const keys = generateVapidKeys("mailto:owner@example.com");
	const header = vapidAuthorization(
		"https://fcm.googleapis.com/fcm/send/abc",
		keys,
		1_700_000_000,
	);
	const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
	assert.ok(match);
	const [, head, claims, signature, k] = match;
	assert.equal(k, keys.publicKey);

	const decoded = JSON.parse(fromB64url(claims).toString());
	assert.equal(decoded.aud, "https://fcm.googleapis.com");
	assert.equal(decoded.sub, "mailto:owner@example.com");
	assert.equal(decoded.exp, 1_700_000_000 + 12 * 60 * 60);

	const raw = fromB64url(keys.publicKey);
	const publicKey = createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: b64url(raw.subarray(1, 33)),
			y: b64url(raw.subarray(33, 65)),
		},
		format: "jwk",
	});
	assert.ok(
		verify(
			"sha256",
			Buffer.from(`${head}.${claims}`),
			{ key: publicKey, dsaEncoding: "ieee-p1363" },
			fromB64url(signature),
		),
	);
});

test("only posts to the push services browsers use", () => {
	assert.ok(isPushEndpoint("https://fcm.googleapis.com/fcm/send/x"));
	assert.ok(isPushEndpoint("https://web.push.apple.com/QG9"));
	assert.ok(
		isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"),
	);
	assert.ok(
		isPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x"),
	);
	assert.ok(!isPushEndpoint("http://fcm.googleapis.com/fcm/send/x"));
	assert.ok(!isPushEndpoint("https://169.254.169.254/latest"));
	assert.ok(!isPushEndpoint("https://evilgoogleapis.com/x"));
	assert.ok(!isPushEndpoint("not a url"));
});

test("a payload with a long link falls back to the inbox link", () => {
	const fitted = fitPayload({
		id: "1",
		kind: "alert",
		title: "Revenue",
		body: "Revenue is above target",
		link: `/explore/?q=${"a".repeat(6000)}`,
	});
	assert.equal(fitted.link, "/inbox/");
	assert.equal(fitted.body, "Revenue is above target");
	assert.ok(
		Buffer.byteLength(JSON.stringify(fitted), "utf8") <= payloadBudget,
	);
});

test("a short payload keeps its link", () => {
	const fitted = fitPayload({
		id: "1",
		kind: "alert",
		title: "Revenue",
		body: "Revenue is above target",
		link: "/explore/?q=abc",
	});
	assert.equal(fitted.link, "/explore/?q=abc");
});

test("a title is cut on a character boundary", () => {
	const fitted = fitPayload({
		id: "1",
		kind: "alert",
		title: "\u{1F600}".repeat(200),
		body: "",
		link: "/inbox/",
	});
	assert.equal(Array.from(fitted.title).length, 120);
	assert.ok(!/[\uD800-\uDBFF]$/.test(fitted.title));
});
