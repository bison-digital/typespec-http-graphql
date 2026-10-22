import "@typespec/http";

using Http;

/**
 * Status ranges `typespec-http-zod` refuses to publish, with `unsupported-status-code-range`, and
 * keys all the same: an emit carries on past a library's error, so the planning still meets them.
 */
@service(#{ title: "Refused ranges" })
namespace RefusedRanges;

model Widget {
  id: string;
}

@error model Below {
  @statusCode @minValue(0) @maxValue(99) status: int32;
  code: string;
}

@error model Above {
  @statusCode @minValue(500) @maxValue(999) status: int32;
  code: string;
}

@error model Straddle {
  @statusCode @minValue(499) @maxValue(500) status: int32;
  code: string;
}

@route("/widgets")
interface Widgets {
  @post @route("/below") below(): Widget | Below;
  @post @route("/above") above(): Widget | Above;
  @post @route("/straddle") straddle(): Widget | Straddle;
}
