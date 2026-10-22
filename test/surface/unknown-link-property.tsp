import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
// `ownerId` is not a property of Widget.
@@link(Widget, "owner", Authors.read, #{ authorId: "ownerId" });
// `authorId` is inherited by Gadget from Widget, so it binds.
@@link(Gadget, "author", Authors.read, #{ authorId: "authorId" });
