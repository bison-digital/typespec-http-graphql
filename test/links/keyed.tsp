import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A bookshop's reviews, each of a book or of an author: `subject_type` says which `subject_id` is. */
@service
namespace Bookshop;

model Book {
  id: string;
  title: string;
}

model Author {
  id: string;
  name: string;
}

model Review {
  id: string;
  subject_type: "book" | "author" | "series";
  subject_id: string | null;
  @maxItems(3) subject_ids?: string[];
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/books")
interface Books {
  @get read(@path id: string): Book | NotFound;
  @route("/titles") @get titles(@path id: string): string[];
}

@route("/authors")
interface Authors {
  @get read(@path authorId: string): Author | NotFound;
  @route("/search") @get search(@path authorId: string, @query language: string): Author | NotFound;
}

@route("/books/sorted")
interface SortedBooks {
  @get read(@path id: string, @query order?: "asc" | "desc", @query lang?: string): Book | NotFound;
  @route("/ranked") @get rank(@path id: string, @query order?: "asc" | "desc"): Book | NotFound;
}

@route("/authors/sorted")
interface SortedAuthors {
  @route("/ranked") @get rank(@path authorId: string, @query order?: "asc" | "desc" | "random"): Author | NotFound;
  @route("/reordered") @get reordered(@query lang?: string, @path authorId: string, @query order?: "asc" | "desc"): Author | NotFound;
}

@route("/books/former")
interface FormerBooks {
  #deprecated "read a book at /books"
  @get read(@path id: string): Book | NotFound;
}

@route("/authors/former")
interface FormerAuthors {
  #deprecated "read an author at /authors"
  @get read(@path authorId: string): Author | NotFound;
}

@route("/reviews")
interface Reviews {
  @get read(@path id: string): Review | NotFound;
  @get list(): Review[];
}

@@queryField(Reviews.read, "review");
@@queryField(Reviews.list, "reviews");

// A review's subject: a book or an author, each read only for the reviews of its kind.
@@link(Review, "subject", Books.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "subject", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// One arm alone: the book, read only for a review of one.
@@link(Review, "book", Books.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });

// A list of subjects, each read by the arm the review's kind names.
@@link(Review, "subjects", Books.read, #{ id: "subject_ids" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "subjects", Authors.read, #{ authorId: "subject_ids" }, #{ when: #{ subject_type: "author" } });

// An arm answering a list of strings is no member of a union: that arm is dropped, the other kept.
@@link(Review, "about", Books.titles, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "about", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// Arms whose arguments differ cannot be one field: both are dropped.
@@link(Review, "found", Books.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "found", Authors.search, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// Arms taking the same arguments in another order, each its own `"asc" | "desc"`: one field.
@@link(Review, "listed", SortedBooks.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "listed", SortedAuthors.reordered, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// Arms reached only here whose `order`s are named alike but hold other values, `"random"` the
// author's alone: both are dropped.
@@link(Review, "ranked", SortedBooks.rank, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "ranked", SortedAuthors.rank, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// Every arm's read deprecated: the field is, for each reason.
@@link(Review, "former", FormerBooks.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "former", FormerAuthors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// One arm's read deprecated: the field is not, since a review of the other kind still reads it.
@@link(Review, "partly", FormerBooks.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "book" } });
@@link(Review, "partly", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
