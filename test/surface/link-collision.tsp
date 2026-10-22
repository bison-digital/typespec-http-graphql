import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });

// Two links of one parent named `owner`: both are dropped.
@@link(Widget, "owner", Authors.read, #{ authorId: "authorId" });
@@link(Widget, "owner", Authors.byNumber, #{ number: "count" });

// `display_name` is the GraphQL field `displayName`.
@@link(Widget, "displayName", Authors.read, #{ authorId: "authorId" });

// `createdAt` is sent as `made_on`, so its GraphQL field is `madeOn`, which this collides with...
@@link(Widget, "madeOn", Authors.read, #{ authorId: "authorId" });
// ...while `createdAt`, its TypeSpec name, names no GraphQL field, so this does not.
@@link(Widget, "createdAt", Authors.read, #{ authorId: "authorId" });

// The same name on a different parent is a different field.
@@link(Gadget, "owner", Authors.read, #{ authorId: "authorId" });
