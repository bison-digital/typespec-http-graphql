import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A list parameter under `@encode`, in each place one is sent: a query list under an array encoding
 * (Q, S), a path list (P), a header list (H), and a query list under a custom encoding (C).
 * `typespec-http-zod` refused four of the REST rows before 0.30.0.
 */
@service(#{ title: "Lists" })
namespace Lists;

model Thing {
  id: string;
}

@route("/q") @get op q(@query @encode(ArrayEncoding.pipeDelimited) ids: int32[]): Thing;
@route("/p/{ids}") @get op p(@path @encode(ArrayEncoding.commaDelimited) ids: string[]): Thing;
@route("/h") @get op h(@header("x-tags") @encode(ArrayEncoding.commaDelimited) tags: string[]): Thing;
@route("/c") @get op c(@query @encode("x-custom", string) tags: string[]): Thing;
@route("/s") @get op s(@query @encode(ArrayEncoding.commaDelimited) tags: string[]): Thing;

@@queryField(q, "q");
@@queryField(p, "p");
@@queryField(h, "h");
@@queryField(c, "c");
@@queryField(s, "s");
