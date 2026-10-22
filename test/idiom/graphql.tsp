// The GraphQL surface. Delete this file, and its import in main.tsp, to drop GraphQL.
import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Bookshop;

@@queryField(Publishers.read, "publisher");
@@queryField(Authors.read, "author");
@@queryField(Authors.list, "authors");
@@queryField(Editors.read, "editor");
@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@queryField(Editions.read, "edition");

@@mutationField(Books.create, "createBook");
@@mutationField(Books.update, "updateBook");
@@mutationField(Books.remove, "deleteBook");

@@link(Book, "author", Authors.read, #{ authorId: "author_id" });
@@link(Book, "editor", Editors.read, #{ editorId: "editor_id" });
@@link(Book, "commissionedBy", Editors.read, #{ editorId: "commissioned_by_id" });
@@link(Book, "editions", BookEditions.list, #{ bookId: "id" });
@@link(Author, "editors", Authors.listEditors, #{ authorId: "id" });
