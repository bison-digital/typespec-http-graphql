import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

// A client never reads `authorId` (create-only) or `etag` (a header), so a link bound to either
// could never resolve.
@@link(Signing, "author", Authors.read, #{ authorId: "authorId" });
@@link(Signing, "tagged", Authors.read, #{ authorId: "etag" });
// `readAuthorId` is in the read body, so it binds.
@@link(Signing, "readAuthor", Authors.read, #{ authorId: "readAuthorId" });
