import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

// `authorId: string | null` fills `authorId: string`: the property's null is not compared.
@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
// `count: int32` fills `number: int64`: int32 is assignable to int64.
@@link(Widget, "authorByCount", Authors.byNumber, #{ number: "count" });
// `count: int32` cannot fill `authorId: string`.
@@link(Widget, "authorByMistake", Authors.read, #{ authorId: "count" });
