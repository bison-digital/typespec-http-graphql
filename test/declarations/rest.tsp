import "@typespec/http";

using Http;

/** A catalogue holding what `@json`, `@inputHeader` and a field's own description act on. */
@service
namespace Catalog;

model Category {
  id: string;
  name: string;
}

/** Settings of any name: additional properties, which a GraphQL object type cannot carry. */
model Settings {
  ...Record<string>;
}

/** A shade by name or by level: variants neither literals nor discriminated. */
union Shade {
  name: string,
  level: float64,
}

/** A token whose shape the service does not state. */
scalar Opaque;

model Product {
  id: string;
  category_id: string;
  name: string;
  /** Any JSON value. */
  extra: string | float64 | boolean | null | Record<unknown> | unknown[];
  settings: Settings;
  shade: Shade;
  token: Opaque;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/categories")
interface Categories {
  /** Fetch one category. Answers 404 when there is none. */
  @get read(@path id: string, @header("Accept-Language") acceptLanguage?: string): Category | NotFound;
}

/** Exposed by no field: what `@inputHeader` names on it is checked all the same. */
@route("/audits")
interface Audits {
  @get read(@header("X-Store") store: string, @header accept: "application/json"): {
    @statusCode _: 200;
    ok: boolean;
  };
}

@route("/products")
interface Products {
  /** Fetch one product. Answers 404 when there is none; send `?fields=a&fields=b` to pick fields. */
  @get read(@path id: string, @header("X-Request-Id") requestId?: string): Product | NotFound;
  @post create(
    @header("Idempotency-Key") idempotencyKey?: string,
    @header("X-Request-Id") requestId?: string,
    @body body: { name: string },
  ): { @statusCode _: 201; @body body: Product };
}
