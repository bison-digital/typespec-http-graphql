import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

// Plausible model names that GraphQL already owns: a root type, a built-in scalar, and a scalar
// this emitter's runtime defines. None may become a type of its own, and none may crash the emitter,
// fail createSchema, or bend the schema without a word.
@service(#{ title: "Reserved" })
namespace Reserved;

model Query {
  text: string;
}

model Subscription {
  plan: string;
}

model String {
  value: string;
}

// Declared before the property that uses the runtime `Duration` scalar, so the outcome cannot depend
// on which the walk meets first.
model Duration {
  start: utcDateTime;
  end: utcDateTime;
}

enum ID {
  a,
  b,
}

model Report {
  id: string;
  query: Query;
  subscription: Subscription;
  label: String;
  window: Duration;
  length: duration;
  kind: ID;
}

@route("/reports/{id}") @get op read(@path id: string): Report;

@@queryField(read, "report");
