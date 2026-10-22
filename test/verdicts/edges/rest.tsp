import "@typespec/http";

using Http;

/**
 * Constructs once mis-projected, each in the position where it went wrong: an `@encode`d
 * parameter, an `unknown` property, a required `T | null` input field, a property whose wire key
 * `Object.prototype` also owns, a deprecated argument, an argument default, a page whose items may
 * be null, and a `@discriminator` base declaring its discriminator under another wire key.
 * The verdict oracle probes every one through GraphQL and the library's own Zod.
 */
@service(#{ title: "Edges" })
namespace Edges;

enum Shade {
  light: "light-shade",
  dark: "dark-shade",
}

model Entry {
  id: string;

  /** Whatever the caller attached, kept as given. */
  payload: unknown;

  /** A wire key `Object.prototype` also owns. */
  `constructor`?: string;

  valueOf?: string;
  shade: Shade;
  tags: string[];

  @encode("seconds", float64)
  wait: duration;
}

model EntryCreate {
  name: string;

  /** Required, and may be null: the caller must say which. */
  note: string | null;

  remark?: string;
  shade?: Shade;

  /** Stated in the schema, and applied by the library's Zod alike. */
  priority?: int32 = 3;

  /** An enum default: applied by the library's Zod, and never stated in the schema. */
  tone?: Shade = Shade.dark;
}

model EntryPage {
  @pageItems items: (Entry | null)[];
  @continuationToken next?: string;
}

/** openapi3 publishes `Animal` with `type` and the `kind` it adds, and `Bird` with both. */
@discriminator("kind")
model Animal {
  @encodedName("application/json", "type") kind: string;
  legs: int32;
}

model Bird extends Animal {
  kind: "bird";
  wings: int32;
}

@error
model Missing {
  @statusCode _: 404;
  message: string;
}

@route("/entries")
namespace Entries {
  @get op read(
    @path id: string,
    @header("x-wait") @encode("seconds", float64) wait: duration,
  ): Entry | Missing;

  @get
  @route("/since")
  op since(@query @encode(DateTimeKnownEncoding.unixTimestamp, int64) since: utcDateTime): Entry[];

  @list
  @get
  @route("/page")
  op list(
    @query @pageSize @minValue(1) @maxValue(50) size?: int32 = 10,
    @query @continuationToken token?: string,
    #deprecated "filter by shade instead"
    @query legacy?: string,
    @query shade?: Shade = Shade.light,
  ): EntryPage;

  @post op create(...EntryCreate): Entry;

  @get @route("/animal") op animal(): Animal;
}
