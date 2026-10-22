// The REST half of the bookshop fixture: authors, books and their editions.
import "@typespec/http";

using Http;

@service(#{ title: "Bookshop" })
namespace Bookshop;

model Author {
  @key id: string;
  name: string;
}

/** A book, and the author who wrote it, where one is known. */
model Book {
  @key @visibility(Lifecycle.Read) id: string;
  @encodedName("application/json", "author_id") authorId: string | null;
  title: string;
  @visibility(Lifecycle.Read) @encodedName("application/json", "created_at") createdAt: utcDateTime;
}

model Edition {
  @key id: string;
  @encodedName("application/json", "book_id") bookId: string;
  name: string;
}

@error model NotFound {
  @statusCode _: 404;
  message: string;
}

@error model Conflict {
  @statusCode _: 409;
  message: string;
}

model Page<Item> {
  @pageItems items: Item[];
  @continuationToken @encodedName("application/json", "nextCursor") next_cursor?: string;
}

model PageRequest {
  /** How many items to return. */
  @query @pageSize @maxValue(200) limit?: int32 = 50;

  /** Where the previous page ended. */
  @query @continuationToken cursor?: string;
}

@route("/authors")
interface Authors {
  /** Read one author. */
  @get read(@path authorId: string): Author | NotFound;
}

@route("/books")
interface Books {
  /** Read one book. */
  @get read(@path bookId: string): Book | NotFound;

  @list @get list(...PageRequest, @query authorId?: string): Page<Book>;

  @post create(@body body: Book): {
    @statusCode _: 201;
    @body body: Book;
  } | Conflict;
}

@route("/books/{bookId}/editions")
interface BookEditions {
  @list @get list(@path bookId: string, ...PageRequest): Page<Edition>;
}
