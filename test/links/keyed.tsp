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
