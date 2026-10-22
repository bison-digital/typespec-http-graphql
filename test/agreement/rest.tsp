import "@typespec/http";

using Http;

/**
 * One of every handler INPUT shape the two emitters derive, and one of every result shape a field
 * resolves, in the vocabulary of the acceptance fixture.
 *
 * Inputs: a path parameter, a query parameter whose wire name is not GraphQL style, an optional
 * header and an optional precondition header (both left out of GraphQL, yet still in the handler's
 * type), a required header, a cookie, a required model body (merged into the input),
 * an optional body (named), a body that is not a model (named), a single-literal content type, and
 * an `accept` that selects one of two operations on one route.
 *
 * Results: a success with a header, a bodyless `204`, a `304` no field projects, failures a field
 * answers as `null`, as a top-level error and as a union member, and a text body only the HTTP
 * surface serves.
 */
@service(#{ title: "Agreement" })
@useAuth(BearerAuth)
namespace Agreement;

alias ProblemFields = {
  @header contentType: "application/problem+json";
  type: string;
  title: string;
  status: int32;
  detail?: string;
};

@error
model ValidationProblem {
  @statusCode statusCode: 400;
  ...ProblemFields;
}

@error
model NotFoundProblem {
  @statusCode statusCode: 404;
  ...ProblemFields;
}

@error
model ConflictProblem {
  @statusCode statusCode: 409;
  ...ProblemFields;
}

model NotModified {
  @statusCode statusCode: 304;
  @header etag: string;
}

model Page<Item> {
  @pageItems items: Item[];

  @continuationToken
  @encodedName("application/json", "nextCursor")
  next_cursor: string | null;
}

model PageRequest {
  @query @pageSize @minValue(1) @maxValue(200) limit?: int32 = 50;
  @query @continuationToken @minLength(1) cursor?: string;
}

enum BookStatus {
  draft,
  published,
}

model Author {
  id: string;
  name: string;
}

model Book {
  id: string;

  @encodedName("application/json", "authorId")
  author_id: string | null;

  title: string | null;
  status: BookStatus;
}

model CreateBookRequest {
  @minLength(1)
  @encodedName("application/json", "originalLanguage")
  original_language: string;

  title?: string | null;
}

model UpdateBookRequest {
  title?: string | null;
}

model Note {
  text: string;
}

model Preferences {
  locale: string;
}

model Excerpt {
  @encodedName("application/json", "bookId")
  book_id: string;

  text: string;
}

model CreatedBook {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: Book;
}

@route("/v1/authors")
interface Authors {
  @route("/{authorId}")
  @get
  read(@header("X-Request-Id") requestId?: string, @path authorId: string): Author | NotFoundProblem;
}

@route("/v1/books")
interface Books {
  @list
  @get
  list(
    ...PageRequest,
    @query("editor-id") editorId?: string,
  ): Page<Book> | ValidationProblem;

  @route("/{bookId}")
  @get
  read(
    @path bookId: string,
    @header("If-None-Match") ifNoneMatch?: string,
  ): Book | NotModified | NotFoundProblem;

  @post
  create(
    @header("Idempotency-Key") idempotencyKey?: string,
    @body body: CreateBookRequest,
  ): CreatedBook | ValidationProblem | ConflictProblem;

  @route("/{bookId}")
  @patch(#{ implicitOptionality: false })
  update(
    @path bookId: string,
    @header contentType: "application/merge-patch+json",
    @body body: UpdateBookRequest,
  ): Book | NotFoundProblem;

  @route("/{bookId}")
  @delete
  remove(@path bookId: string): NoContentResponse | NotFoundProblem;

  @route("/{bookId}/notes")
  @post
  note(@path bookId: string, @body body?: Note): Book | NotFoundProblem;

  @route("/{bookId}/tags")
  @put
  tag(@path bookId: string, @body tags: string[]): Book | NotFoundProblem;

  @route("/{bookId}/preferences")
  @get
  preferences(
    @path bookId: string,
    @cookie locale?: string,
    @header("x-api-version") apiVersion: string,
  ): Preferences;

  @sharedRoute
  @route("/{bookId}/excerpt")
  @get
  excerptAsText(@path bookId: string, @header accept: "text/plain"): {
    @header contentType: "text/plain";
    @body body: string;
  };

  @sharedRoute
  @route("/{bookId}/excerpt")
  @get
  excerptAsJson(
    @path bookId: string,
    @header accept: "application/json",
  ): Excerpt | NotFoundProblem;
}
