import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A bookshop whose handlers can call more than one backend: each field weighs the calls it makes. */
@service
namespace Bookshop;

model Book {
  id: string;
  title: string;
  author_id: string;
  subject_type: "author" | "editor";
  @maxItems(3) editor_ids: string[];
  @maxItems(4) tag_ids: string[];
}

model Author {
  id: string;
  name: string;
}

model Editor {
  id: string;
  name: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

model BookPage {
  @pageItems items: Book[];
  @continuationToken next?: string;
}

@route("/books")
interface Books {
  @route("/{id}") @get read(@path id: string): Book | NotFound;
  @list @get list(@query @pageSize limit?: int32 = 10, @query @continuationToken cursor?: string): BookPage;
  @post create(@body body: { title: string }): { @statusCode _: 201; @body book: Book };
}

@route("/authors")
interface Authors {
  @route("/{id}") @get read(@path id: string): Author | NotFound;
  @route("/batch") @get batchGet(@query(#{ explode: true }) @maxItems(2) ids: string[]): Author[];
}

@route("/editors")
interface Editors {
  @route("/{id}") @get read(@path id: string): Editor | NotFound;
}

@@queryField(Books.read, "book", #{ weight: "2" });
@@queryField(Books.list, "books", #{ weight: "3" });
@@mutationField(Books.create, "createBook", #{ weight: "2" });
@@queryField(Editors.read, "editor");
@@queryField(Authors.batchGet, "authors", #{ weight: "1e" });

// A call per value of the list, each weighing 2.
@@link(Book, "editors", Editors.read, #{ id: "editor_ids" }, #{ weight: "2" });
// ceil(4 / 2) batch calls, each weighing 0.1.
@@link(Book, "tagged", Authors.batchGet, #{ ids: "tag_ids" }, #{ batch: #{ key: "id" }, weight: "0.1" });
// 3 calls, each weighing 0.1: 0.3, as a person states it, not 0.30000000000000004.
@@link(Book, "editorsLight", Editors.read, #{ id: "editor_ids" }, #{ weight: "0.1" });
// 3 calls, each weighing past a third of the largest double: the largest double, not Infinity.
@@link(Book, "editorsHeavy", Editors.read, #{ id: "editor_ids" }, #{ weight: "1e308" });
// A link chosen by a kind, weighed as its costliest arm.
@@link(Book, "subject", Authors.read, #{ id: "author_id" }, #{ when: #{ subject_type: "author" }, weight: "2" });
@@link(Book, "subject", Editors.read, #{ id: "author_id" }, #{ when: #{ subject_type: "editor" }, weight: "5" });
// Weights that are no number of calls.
@@link(Book, "signed", Authors.read, #{ id: "author_id" }, #{ weight: "-1" });
@@link(Book, "words", Authors.read, #{ id: "author_id" }, #{ weight: "two" });
@@link(Book, "empty", Authors.read, #{ id: "author_id" }, #{ weight: "" });
@@link(Book, "huge", Authors.read, #{ id: "author_id" }, #{ weight: "1e400" });
@@link(Book, "tiny", Authors.read, #{ id: "author_id" }, #{ weight: "1e-400" });
// 0 written with an exponent is 0: a field that makes no call.
@@link(Book, "free", Authors.read, #{ id: "author_id" }, #{ weight: "0e5" });
