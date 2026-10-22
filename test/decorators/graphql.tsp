// The GraphQL surface. Delete this file and the emitter line to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Books;

@@queryField(BooksApi.read, "book");
@@queryField(BooksApi.list, "books");
@@mutationField(BooksApi.create, "createBook");

// The same operation declared twice: recorded twice, so the emitter can say `declared-twice`.
@@queryField(BooksApi.list, "booksAgain");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Author, "books", BooksApi.list, #{ authorId: "id" });
@@link(Author, "everything", BooksApi.list);
