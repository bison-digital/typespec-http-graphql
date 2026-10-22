// graphql.tsp: the GraphQL surface. Delete this file and the emitter line to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@mutationField(Books.create, "createBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Book, "editor", Editors.read, #{ editorId: "editor_id" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
