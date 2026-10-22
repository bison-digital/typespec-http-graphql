import "@typespec/http";

using Http;

/**
 * A bookshop: authors, editors, books and their editions, with snake_case wire names and the core
 * paging decorators on its page models.
 */
@service(#{ title: "Bookshop" })
@useAuth(BearerAuth)
namespace Bookshop;

model Author {
  id: string;
  name: string;
}

model Editor {
  editor_id: string;
  display_name: string;
}

enum BookStatus {
  in_print,
  out_of_print,
}

model Book {
  @visibility(Lifecycle.Read) id: string;
  title: string;
  status: BookStatus;
  author_id: string;
  editor_id: string | null;
  @visibility(Lifecycle.Read) created_at: utcDateTime;
}

model Edition {
  id: string;
  book_id: string;
  name: string;
}

model Page<Item> {
  @pageItems items: Item[];
  @continuationToken next_token?: string;
}

model PageRequest {
  @query("page-size") @pageSize pageSize?: int32 = 20;
  @query("page-token") @continuationToken pageToken?: string;
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

@route("/authors")
namespace Authors {
  @get op read(@path authorId: string): Author | NotFound;
}

@route("/editors")
namespace Editors {
  @get op read(@path editorId: string): Editor | NotFound;
}

@route("/books")
namespace Books {
  @get op read(@path id: string): Book | NotFound;

  @list
  @get
  op list(...PageRequest, @query status?: BookStatus): Page<Book>;

  @post op create(
    // Optional, so never a GraphQL argument: the mutation's input leaves it out.
    @header("x-request-id") requestId?: string,
    @header("x-api-version") apiVersion: string,
    @body book: Book,
  ): {
    @statusCode _: 201;
    @body book: Book;
  } | Conflict;

  /** Declared by the document and exposed by no GraphQL field. */
  @delete op remove(@path id: string): NoContentResponse | NotFound;
}

@route("/books/{bookId}/editions")
namespace BookEditions {
  @list @get op list(@path bookId: string, ...PageRequest): Page<Edition>;
}
