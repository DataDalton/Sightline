import assert from "node:assert/strict";
import { test } from "node:test";
import { bareHostname } from "./hostname";

const host = "instance-99da9a20.database.azuredatabricks.net";

test("a bare hostname is left alone", () => {
	assert.equal(bareHostname(host), host);
});

test("a scheme is removed", () => {
	assert.equal(bareHostname(`https://${host}`), host);
	assert.equal(bareHostname(`http://${host}`), host);
	assert.equal(bareHostname(`postgres://${host}`), host);
});

test("a trailing slash is removed", () => {
	assert.equal(bareHostname(`${host}/`), host);
	assert.equal(bareHostname(`http://${host}/`), host);
});

test("a path, query or fragment is removed", () => {
	assert.equal(bareHostname(`${host}/some/path`), host);
	assert.equal(bareHostname(`${host}?sslmode=require`), host);
	assert.equal(bareHostname(`${host}#note`), host);
});

test("a port is removed, because the connection reads it from PGPORT", () => {
	assert.equal(bareHostname(`${host}:5432`), host);
	assert.equal(bareHostname(`https://${host}:5432/`), host);
});

test("surrounding whitespace is removed", () => {
	assert.equal(bareHostname(`  ${host}  `), host);
});

test("an empty value stays empty, so the missing-configuration check sees it", () => {
	assert.equal(bareHostname(""), "");
	assert.equal(bareHostname("   "), "");
});
