import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
// Widgets.touch is a POST: a link runs on every read that selects it.
@@link(Widget, "touched", Widgets.touch, #{ id: "id" });
