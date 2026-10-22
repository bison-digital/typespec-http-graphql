import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A bookshop's books: the root fields a request is written for, one of each shape. */
@service
namespace Bookshop;

enum Format {
  hardback,
  paperback,
  ebook: "e-book",
}

model Price {
  amount: int32;
  currency: string;
}

model Book {
  id: string;
  title: string;
  format: Format;
  @encodedName("application/json", "page_count") pages: int32;
  price: Price;
}

model BookPage {
  @pageItems items: Book[];
  @continuationToken next?: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@error
model Conflict {
  @statusCode _: 409;
  message: string;
}

model Shelved {
  @statusCode _: 202;
  shelf: string;
}

@route("/books")
interface Books {
  @get read(@path id: string, @query format?: Format): Book | NotFound;
  @list @get list(@query @pageSize limit?: int32 = 10, @query @continuationToken cursor?: string): BookPage;
  @post create(
    @header("Idempotency-Key") idempotencyKey?: string,
    @body body: {
      title: string;
      format: Format;
      price: Price;
    },
  ): {
    @statusCode _: 201;
    @body book: Book;
  } | Conflict;
  @route("/shelve") @get shelve(@path id: string): Book | Shelved;
  /** A body that is a list, which the handler's input carries under its own key. */
  @route("/tags") @post tag(@path id: string, @body labels: string[]): Book | NotFound;
}

@@queryField(Books.read, "book");
@@queryField(Books.list, "books");
@@queryField(Books.shelve, "shelving");
@@mutationField(Books.create, "createBook");
@@mutationField(Books.tag, "tagBook");
@@inputHeader(Books.create, "idempotencyKey");
