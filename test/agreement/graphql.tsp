// Every operation a GraphQL field can carry, declared; `excerptAsText` answers text, so it is not.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Agreement;

@@queryField(Authors.read, "author");
@@queryField(Books.list, "books");
@@queryField(Books.read, "book");
@@queryField(Books.preferences, "preferences");
@@queryField(Books.excerptAsJson, "excerpt");
@@mutationField(Books.create, "createBook");
@@mutationField(Books.update, "updateBook");
@@mutationField(Books.remove, "deleteBook");
@@mutationField(Books.note, "annotateBook");
@@mutationField(Books.tag, "tagBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
