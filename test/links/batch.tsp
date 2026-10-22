import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A bookshop whose authors and publishers are read in batches: one call for a page's distinct ids. */
@service
namespace Bookshop;

model Book {
  id: string;
  title: string;
  author_id: string;
  @maxItems(4) editor_ids?: string[];
}

model Author {
  id: string;
  name: string;
  publisher_id: string;
}

model Publisher {
  id: string;
  name: string;
}

model Review {
  id: string;
  subject_type: "book" | "author";
  subject_id: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/books")
interface Books {
  @get list(): Book[];
  @get read(@path id: string): Book | NotFound;
  @route("/batch") @get batchGet(@query(#{ explode: true }) ids: string[]): { books: Book[] };
}

@route("/authors")
interface Authors {
  @route("/batch") @get batchGet(@query(#{ explode: true }) @maxItems(50) ids: string[]): {
    authors: Author[];
  } | NotFound;
}

@route("/publishers")
interface Publishers {
  @route("/batch") @get batchGet(@query(#{ explode: true }) ids: string[]): Publisher[];
}

@route("/reviews")
interface Reviews {
  @get list(): Review[];
}

@@queryField(Books.list, "books");
@@queryField(Books.read, "book");
@@queryField(Reviews.list, "reviews");

@@link(Book, "author", Authors.batchGet, #{ ids: "author_id" }, #{ batch: #{ key: "id" } });
@@link(Book, "editors", Authors.batchGet, #{ ids: "editor_ids" }, #{ batch: #{ key: "id" } });
@@link(Author, "publisher", Publishers.batchGet, #{ ids: "publisher_id" }, #{ batch: #{ key: "id" } });

// A link chosen by a kind whose arms are each batched: one call per kind for a page of reviews.
@@link(Review, "subject", Books.batchGet, #{ ids: "subject_id" }, #{ when: #{ subject_type: "book" }, batch: #{ key: "id" } });
@@link(Review, "subject", Authors.batchGet, #{ ids: "subject_id" }, #{ when: #{ subject_type: "author" }, batch: #{ key: "id" } });
