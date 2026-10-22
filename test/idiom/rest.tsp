import "@typespec/http";

using Http;

/**
 * A bookshop's publishers, authors, editors, books and editions: snake_case properties published
 * under camelCase wire names, RFC 9457 problems, `Page<Item>` carrying TypeSpec's core paging
 * decorators, conditional reads, and a JSON merge patch.
 *
 * `expected.graphql` is the GraphQL schema a person would write for this domain by hand. The
 * emitted schema has to equal it.
 */
@service(#{ title: "Bookshop" })
namespace Bookshop;

/**
 * The RFC 9457 problem fields every problem carries. A named model rather than an alias, so the
 * GraphQL surface can state what the problem types share as one interface.
 */
model ProblemFields {
  @header contentType: "application/problem+json";
  type: string;
  title: string;
  status: int32;
  detail?: string;

  @encodedName("application/json", "requestId")
  request_id?: string;
}

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

model IfNoneMatchHeader {
  @header("If-None-Match")
  ifNoneMatch?: string;
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

/** Where a publisher is in its life. */
enum PublisherStatus {
  active,
  suspended,
  archived,
}

/** A publisher, or an imprint of one. */
model Publisher {
  @format("uuid")
  id: string;

  @format("uuid")
  @encodedName("application/json", "parentPublisherId")
  parent_publisher_id: string | null;

  name: string;
  status: PublisherStatus;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

/** An author a publisher publishes. */
model Author {
  @format("uuid")
  id: string;

  @format("uuid")
  @encodedName("application/json", "publisherId")
  publisher_id: string;

  name: string;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

/** An editor's role at a publisher. */
enum EditorRole {
  director,
  senior_editor,
  copy_editor,
}

/** Where an editor's contract with a publisher stands. */
enum ContractStatus {
  active,
  offered,
  suspended,
  ended,
}

/** An editor at a publisher, and the authors they edit. */
model Editor {
  @format("uuid")
  id: string;

  @format("uuid")
  @encodedName("application/json", "publisherId")
  publisher_id: string;

  @encodedName("application/json", "displayName")
  display_name: string;

  email: string | null;
  role: EditorRole;
  status: ContractStatus;

  @encodedName("application/json", "authorIds")
  author_ids: string[];

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

/** Where a book is on its way to print. */
enum BookStatus {
  draft,
  published,
  in_review,
  rejected,
  withdrawn,
}

/** A book, and what the bookshop knows about it. */
model Book {
  @format("uuid")
  id: string;

  @format("uuid")
  @encodedName("application/json", "publisherId")
  publisher_id: string;

  @format("uuid")
  @encodedName("application/json", "editorId")
  editor_id: string | null;

  @format("uuid")
  @encodedName("application/json", "commissionedById")
  commissioned_by_id: string | null;

  /** The author who wrote the book: whose list of books it is on. */
  @format("uuid")
  @encodedName("application/json", "authorId")
  author_id: string | null;

  title: string | null;
  status: BookStatus;

  /** Caller-supplied metadata, stored as given. */
  metadata: Record<unknown>;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;

  @encodedName("application/json", "updatedAt")
  updated_at: utcDateTime;
}

model CreateBookRequest {
  @minLength(1)
  @encodedName("application/json", "originalLanguage")
  original_language: string;

  @minLength(1)
  title?: string | null;

  @format("uuid")
  @encodedName("application/json", "editorId")
  editor_id?: string | null;

  @format("uuid")
  @encodedName("application/json", "authorId")
  author_id?: string | null;

  metadata?: Record<unknown>;
}

/** An RFC 7396 JSON merge patch: an absent member is left alone, and `null` clears it. */
model UpdateBookRequest {
  @minLength(1)
  title?: string | null;

  @format("uuid")
  @encodedName("application/json", "editorId")
  editor_id?: string | null;

  @format("uuid")
  @encodedName("application/json", "authorId")
  author_id?: string | null;

  metadata?: Record<unknown>;
}

/** The form an edition takes. */
enum EditionType {
  print_hardback,
  ebook_epub,
  print_paperback,
}

/** A form a book is published in: a hardback, an ebook, a paperback. */
model Edition {
  @format("uuid")
  id: string;

  @format("uuid")
  @encodedName("application/json", "bookId")
  book_id: string;

  @encodedName("application/json", "editionName")
  edition_name: string;

  @encodedName("application/json", "editionType")
  edition_type: EditionType;

  @encodedName("application/json", "versionNumber")
  version_number: int32;

  checksum: string | null;
  metadata: Record<unknown>;

  @encodedName("application/json", "createdAt")
  created_at: utcDateTime;
}

model AuthorPage is Page<Author>;

model EditorPage is Page<Editor>;

model BookPage is Page<Book>;

model EditionPage is Page<Edition>;

model PublisherRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Publisher;
}

model AuthorRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Author;
}

model EditorRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Editor;
}

model BookRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Book;
}

model EditionRead {
  @statusCode statusCode: 200;
  @header etag: string;
  @body body: Edition;
}

model CreatedBook {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: Book;
}

@route("/v1/publishers")
@useAuth(BearerAuth)
interface Publishers {
  @route("/{publisherId}")
  @get
  read(
    ...IfNoneMatchHeader,
    @path @format("uuid") publisherId: string,
  ): PublisherRead | NotModified | NotFoundProblem | CommonProblems;
}

@route("/v1/authors")
@useAuth(BearerAuth)
interface Authors {
  @list
  @get
  list(...PageRequest): AuthorPage | CommonProblems;

  @route("/{authorId}")
  @get
  read(
    ...IfNoneMatchHeader,
    @path @format("uuid") authorId: string,
  ): AuthorRead | NotModified | NotFoundProblem | CommonProblems;

  @list
  @route("/{authorId}/editors")
  @get
  listEditors(
    @path @format("uuid") authorId: string,
    ...PageRequest,
  ): EditorPage | NotFoundProblem | CommonProblems;
}

@route("/v1/editors")
@useAuth(BearerAuth)
interface Editors {
  @route("/{editorId}")
  @get
  read(
    ...IfNoneMatchHeader,
    @path @format("uuid") editorId: string,
  ): EditorRead | NotModified | NotFoundProblem | CommonProblems;
}

@route("/v1/books")
@useAuth(BearerAuth)
interface Books {
  @post
  create(@body body: CreateBookRequest):
    | CreatedBook
    | ValidationProblem
    | ConflictProblem
    | CommonProblems;

  @list
  @get
  list(...PageRequest): BookPage | CommonProblems;

  @route("/{bookId}")
  @get
  read(
    ...IfNoneMatchHeader,
    @path @format("uuid") bookId: string,
  ): BookRead | NotModified | NotFoundProblem | CommonProblems;

  @route("/{bookId}")
  @patch(#{ implicitOptionality: false })
  update(
    @path @format("uuid") bookId: string,
    @header contentType: "application/merge-patch+json",
    @body body: UpdateBookRequest,
  ):
    | Book
    | ValidationProblem
    | NotFoundProblem
    | ConflictProblem
    | CommonProblems;

  @route("/{bookId}")
  @delete
  remove(@path @format("uuid") bookId: string):
    | NoContentResponse
    | NotFoundProblem
    | CommonProblems;
}

@route("/v1/books/{bookId}/editions")
@useAuth(BearerAuth)
interface BookEditions {
  @list
  @get
  list(
    ...PageRequest,
    @path @format("uuid") bookId: string,
    @query(#{ explode: true }) editionType?: EditionType[],
    @query editionName?: string,
    @query allVersions?: boolean,
  ): EditionPage | ValidationProblem | CommonProblems;
}

@route("/v1/editions")
@useAuth(BearerAuth)
interface Editions {
  @route("/{editionId}")
  @get
  read(
    ...IfNoneMatchHeader,
    @path @format("uuid") editionId: string,
  ): EditionRead | NotModified | NotFoundProblem | CommonProblems;
}
