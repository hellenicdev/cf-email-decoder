process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeCfEmail, extractEmails, extractPhones, extractLinks } = require("../server");

test("decodeCfEmail", () => {
    const key = 0x27;
    const email = "test@example.com";
    const encoded = email.split("").map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    const payload = key.toString(16).padStart(2, "0") + encoded;
    assert.equal(decodeCfEmail(payload), "test@example.com");
});

test("decodeCfEmail rejects bad hex", () => {
    assert.equal(decodeCfEmail("xyz"), null);
});

test("decodeCfEmail rejects non-email", () => {
    assert.equal(decodeCfEmail("271234"), null);
});

test("extractEmails CF", () => {
    const key = 0x27;
    const email = "test@example.com";
    const encoded = email.split("").map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    const payload = key.toString(16).padStart(2, "0") + encoded;
    const found = extractEmails('<a data-cfemail="' + payload + '">x</a>');
    assert.ok(found.includes("test@example.com"));
});

test("extractEmails mailto", () => {
    const found = extractEmails('<a href="mailto:u@t.co?sub=hi">x</a>');
    assert.ok(found.includes("u@t.co"));
});

test("extractEmails plain", () => {
    const found = extractEmails("hi@there.com");
    assert.ok(found.includes("hi@there.com"));
});

test("extractEmails filters image-like", () => {
    const found = extractEmails("a@b.png c@d.com");
    assert.equal(found.includes("a@b.png"), false);
    assert.ok(found.includes("c@d.com"));
});

test("extractEmails HTML entities", () => {
    const found = extractEmails("&#116;&#101;&#115;&#116;&#64;&#116;&#101;&#115;&#116;&#46;&#99;&#111;&#109;");
    assert.ok(found.includes("test@test.com"));
});

test("extractPhones finds", () => {
    assert.ok(extractPhones("Call +1 (555) 123-4567").length > 0);
});

test("extractPhones filters short", () => {
    assert.equal(extractPhones("v2.0 call 123").length, 0);
});

test("extractLinks relative", () => {
    const found = extractLinks('<a href="/page">x</a>', "https://ex.com");
    assert.ok(found.includes("https://ex.com/page"));
});

test("extractLinks stop domains", () => {
    const found = extractLinks('<a href="https://facebook.com/x">x</a>', "https://ex.com");
    assert.equal(found.some(link => link.includes("facebook.com")), false);
});

test("extractLinks filters javascript:", () => {
    const found = extractLinks('<a href="javascript:void(0)">x</a>', "https://ex.com");
    assert.equal(found.includes("javascript:void(0)"), false);
});

test("extractLinks filters .css", () => {
    const found = extractLinks('<a href="https://ex.com/s.css">x</a>', "https://ex.com");
    assert.equal(found.some(link => link.includes(".css")), false);
});
