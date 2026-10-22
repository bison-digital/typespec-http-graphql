// The GraphQL surface of the bookshop fixture, as `design.md` § Vocabulary illustrates it.
import "typespec-http-graphql";
import "./bookshop-rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@mutationField(Books.create, "createBook");

@@link(Book, "author", Authors.read, #{ authorId: "authorId" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
