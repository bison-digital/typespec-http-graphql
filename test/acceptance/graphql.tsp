// The GraphQL surface. Delete this file, and its import in main.tsp, to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@queryField(Authors.read, "author");
@@mutationField(Books.create, "createBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
