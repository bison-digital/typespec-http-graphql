import "@typespec/http";

using Http;

/**
 * Books, the authors who wrote them and the editions they are published in: a small bookshop.
 * Snake_case properties published under camelCase wire names, RFC 9457 problems, `Page<Item>`
 * carrying TypeSpec's core paging decorators, an optional request id header on every operation, and
 * conditional reads. An optional header is never a GraphQL argument,
 * so `x-api-version` on the editions list is the one REQUIRED header: the one header that is an
 * argument, and whose wire name is not GraphQL style.
 *
 * **Two models are written the other way round, with snake_case WIRE names, on purpose.**
 * `Contributor` and `Edition` publish `display_name` and `created_at`: the GraphQL names are
 * camelCase whatever the wire says, so the resolvers have to map each name back to its wire key.
 */
@service(#{ title: "Books" })
namespace Bookshop;

alias ProblemFields = {
  @header contentType: "application/problem+json";
  type: string;
  title: string;
  status: int32;
  detail?: string;

  @encodedName("application/json", "requestId")
  request_id?: string;
};

model ProblemError {
  pointer?: string;
  detail: string;
}

@error
model ValidationProblem {
  @statusCode statusCode: 400;
  ...ProblemFields;
  errors?: ProblemError[];
}

@error
model UnauthorizedProblem {
  @statusCode statusCode: 401;
  @header wwwAuthenticate: string;
  ...ProblemFields;
}

@error
model ForbiddenProblem {
  @statusCode statusCode: 403;
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

@error
model TooManyRequestsProblem {
  @statusCode statusCode: 429;
  @header retryAfter?: int32;
  ...ProblemFields;
}

@error
model ServerProblem {
  @statusCode statusCode: 500 | 501;
  ...ProblemFields;
}

alias CommonProblems =
  | UnauthorizedProblem
  | ForbiddenProblem
  | TooManyRequestsProblem
  | ServerProblem;

model NotModified {
  @statusCode statusCode: 304;
  @header etag: string;
}

/** A page of results. `nextCursor` is the token to send as `cursor` for the next page. */
model Page<Item> {
  @pageItems items: Item[];

  @continuationToken
  @encodedName("application/json", "nextCursor")
  next_cursor: string | null;
}

model PageRequest {
  /** The most items to return. */
  @query
  @pageSize
  @minValue(1)
  @maxValue(200)
  limit?: int32 = 50;

  @query
  @continuationToken
  @minLength(1)
  cursor?: string;
}

model RequestIdHeader {
  @header("X-Request-Id")
  @maxLength(128)
  requestId?: string;
}

model IfNoneMatchHeader {
  @header("If-None-Match")
  ifNoneMatch?: string;
}

enum BookStatus {
  draft,
  published,
  in_review,
  rejected,
  withdrawn,
}

model Author {
  @format("uuid")
  id: string;

  name: string;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

/** A book in the catalogue. */
model Book {
  @format("uuid")
  id: string;

  /** The author who wrote the book, when one is known. */
  @format("uuid")
  @encodedName("application/json", "authorId")
  author_id: string | null;

  @format("uuid")
  @encodedName("application/json", "editorId")
  editor_id: string | null;

  title: string | null;
  status: BookStatus;
  metadata: Record<unknown>;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

/** Someone who contributed to the book, published with snake_case wire names. */
model Contributor {
  key: string;
  display_name?: string | null;
  role?: string;
}

model CreateBookRequest {
  @minLength(1)
  @encodedName("application/json", "originalLanguage")
  original_language: string;

  @minLength(1)
  title?: string | null;

  @minValue(1)
  @encodedName("application/json", "firstPrintRun")
  first_print_run?: int32;

  contributors?: Contributor[];
}

enum EditionType {
  print_hardback,
  ebook_epub,
}

/** An edition, published with snake_case wire names. */
model Edition {
  @format("uuid")
  id: string;

  edition_name: string;
  edition_type: EditionType;
  created_at: utcDateTime;
}

model BookPage is Page<Book>;

model EditionPage is Page<Edition>;

model AuthorRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Author;
}

model BookRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Book;
}

model CreatedBook {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: Book;
}

@route("/v1/authors")
@useAuth(BearerAuth)
interface Authors {
  @route("/{authorId}")
  @get
  read(
    ...RequestIdHeader,
    ...IfNoneMatchHeader,
    @path @format("uuid") authorId: string,
  ): AuthorRead | NotModified | NotFoundProblem | CommonProblems;
}

@route("/v1/books")
@useAuth(BearerAuth)
interface Books {
  @post
  create(
    ...RequestIdHeader,
    @header("Idempotency-Key") @minLength(1) idempotencyKey?: string,
    @body body: CreateBookRequest,
  ): CreatedBook | ValidationProblem | ConflictProblem | CommonProblems;

  @list
  @get
  list(...RequestIdHeader, ...PageRequest): BookPage | CommonProblems;

  @route("/{bookId}")
  @get
  read(
    ...RequestIdHeader,
    ...IfNoneMatchHeader,
    @path @format("uuid") bookId: string,
  ): BookRead | NotModified | NotFoundProblem | CommonProblems;
}

@route("/v1/books/{bookId}/editions")
@useAuth(BearerAuth)
interface BookEditions {
  @list
  @get
  list(
    ...RequestIdHeader,
    ...PageRequest,
    @path @format("uuid") bookId: string,
    @query(#{ explode: true }) editionType?: EditionType[],
    @query("edition-name") editionName?: string,
    @header("x-api-version") apiVersion: string,
  ): EditionPage | ValidationProblem | CommonProblems;
}
