import { describe, expect, test } from "bun:test";
import {
  bucketImageUrl,
  handleHue,
  handleMonogram,
  isLocalHost,
  realmLogoUrl,
} from "../src/network.ts";
import { parseInline, toPlainText } from "../src/markdown_source.ts";
import { parsePost } from "../src/model.ts";

const location = (href: string) => new URL(href) as unknown as Location;

describe("bucket image URLs", () => {
  test("match Taggr's own raw byte-range form on mainnet", () => {
    expect(
      bucketImageUrl(
        { bucket: "bkyz2-fmaaa-aaaaa-qaaaq-cai", offset: 128, len: 4096 },
        location("https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io/app/taggr/index.html"),
      ),
    ).toBe(
      "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.raw.icp0.io/image?offset=128&len=4096",
    );
  });

  test("use the local gateway when the tile is served locally", () => {
    expect(
      bucketImageUrl(
        { bucket: "bkyz2-fmaaa-aaaaa-qaaaq-cai", offset: 0, len: 10 },
        location("http://abcde-aaaaa-aaaaa-aaaaa-cai.localhost:8000/app/taggr/index.html"),
      ),
    ).toBe(
      "http://bkyz2-fmaaa-aaaaa-qaaaq-cai.raw.localhost:8000/image?offset=0&len=10",
    );
  });

  test("recognise local hosts without matching a lookalike domain", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("abc.localhost")).toBe(true);
    expect(isLocalHost("evil-localhost.example")).toBe(false);
  });
});

describe("post attachments", () => {
  const post = (files: Record<string, [number, number]>, body = "") =>
    parsePost({
      id: 1,
      body,
      user: 7,
      timestamp: 1,
      children: [],
      parent: null,
      watchers: [],
      tags: [],
      reactions: {},
      patches: [],
      files,
      tree_size: 1,
      tree_update: 1,
      tips: [],
      extension: null,
      realm: null,
      hashes: [],
      reposts: [],
      encrypted: false,
      hidden_for: [],
    });

  test("split Taggr's \"<id>@<bucket>\" key into its two halves", () => {
    expect(post({ "abc123@bkyz2-fmaaa-aaaaa-qaaaq-cai": [64, 900] }).files).toEqual([
      { id: "abc123", bucket: "bkyz2-fmaaa-aaaaa-qaaaq-cai", offset: 64, len: 900 },
    ]);
  });

  test("split on the last @, because a file id may contain one", () => {
    expect(post({ "a@b@bucket-cai": [1, 2] }).files).toEqual([
      { id: "a@b", bucket: "bucket-cai", offset: 1, len: 2 },
    ]);
  });

  test("drop malformed entries rather than rendering a broken image", () => {
    expect(
      post({
        "no-bucket": [1, 2],
        "@leading": [1, 2],
        "trailing@": [1, 2],
        "ok@bucket": [3, 4],
      }).files,
    ).toEqual([{ id: "ok", bucket: "bucket", offset: 3, len: 4 }]);
  });

  test("treat a post with no files as having none", () => {
    expect(post({}).files).toEqual([]);
  });
});

describe("markdown images", () => {
  test("read an image rather than a stray bang plus a link", () => {
    expect(parseInline("![a cat](/blob/xyz)")).toEqual([
      { kind: "image", alt: "a cat", src: "/blob/xyz" },
    ]);
  });

  test("keep an ordinary link a link", () => {
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { kind: "link", label: "docs", href: "https://example.com" },
    ]);
  });

  test("read an external image", () => {
    expect(parseInline("![](https://example.com/a.png)")).toEqual([
      { kind: "image", alt: "", src: "https://example.com/a.png" },
    ]);
  });

  test("keep surrounding text intact", () => {
    expect(parseInline("look ![x](/blob/1) here")).toEqual([
      { kind: "text", value: "look " },
      { kind: "image", alt: "x", src: "/blob/1" },
      { kind: "text", value: " here" },
    ]);
  });

  test("do not treat an image inside a code span as markup", () => {
    expect(parseInline("`![x](/blob/1)`")).toEqual([
      { kind: "code", value: "![x](/blob/1)" },
    ]);
  });

  test("name images in the plain-text preview instead of dropping them", () => {
    expect(toPlainText("before ![a cat](/blob/x) after")).toBe(
      "before [image: a cat] after",
    );
    expect(toPlainText("![](/blob/x)")).toBe("[image]");
  });
});

describe("realm logos", () => {
  test("wrap Taggr's bare base64 PNG in a data URL", () => {
    expect(realmLogoUrl("iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("treat an absent logo as absent", () => {
    expect(realmLogoUrl("")).toBeNull();
    expect(realmLogoUrl("   ")).toBeNull();
  });

  test("refuse anything that is not plain base64", () => {
    // A realm record is remote data; it must not be able to choose a URL scheme.
    expect(realmLogoUrl("javascript:alert(1)")).toBeNull();
    expect(realmLogoUrl("data:text/html,<script>")).toBeNull();
    expect(realmLogoUrl("../../etc/passwd")).toBeNull();
  });
});

describe("handle monograms", () => {
  test("are stable for one handle and differ across handles", () => {
    expect(handleHue("alice")).toBe(handleHue("alice"));
    expect(handleHue("alice")).not.toBe(handleHue("bob"));
    expect(handleHue("alice")).toBeGreaterThanOrEqual(0);
    expect(handleHue("alice")).toBeLessThan(360);
  });

  test("take the first character, uppercased", () => {
    expect(handleMonogram("alice")).toBe("A");
    expect(handleMonogram(" bob")).toBe("B");
    expect(handleMonogram("")).toBe("?");
  });
});
