import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
// `author` is not a parameter of Authors.read.
@@link(Widget, "authorByKey", Authors.read, #{ author: "authorId" });
// `filter` is Widgets.find's body, which a link cannot fill.
@@link(Widget, "similar", Widgets.find, #{ filter: "display_name" });
