import "typespec-http-graphql";
import "./rest.tsp";

using Http;
using HttpGraphQL;
using Surface;

namespace Surface {
  enum SubjectType {
    author,
    widget,
    gadget,
  }

  /** A review of an author, a widget or a gadget: `subject_type` says which `subject_id` is. */
  model Review {
    @key id: string;
    subject_type: SubjectType;
    subject_id: string;
    @maxItems(5) subject_ids: string[];
    rating: int32;
    tone: "warm" | "cold";
    @visibility(Lifecycle.Create) draft_type: SubjectType;
  }

  @route("/reviews")
  interface Reviews {
    @get read(@path id: string): Review | NotFound;
  }
}

@@queryField(Reviews.read, "review");

// One field, two arms, chosen by `subject_type`: an author, or a widget for either of two values.
@@link(Review, "subject", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
@@link(Review, "subject", Widgets.read, #{ id: "subject_id" }, #{ when: #{ subject_type: #["widget", "gadget"] } });

// One arm alone: a link that calls only for the value it names.
@@link(Review, "author", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });

// link-when-mismatch: a value the property never holds, two properties, a property that is no string,
// and nothing named at all.
@@link(Review, "misspelt", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "editor" } });
@@link(Review, "twoKeys", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author", tone: "warm" } });
@@link(Review, "byRating", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ rating: "1" } });
@@link(Review, "byNothing", Authors.read, #{ authorId: "subject_id" }, #{ when: #{} });
@@link(Review, "noValue", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: #[] } });

// The property `when` names must be one the review's read body carries.
@@link(Review, "byMood", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ mood: "warm" } });
@@link(Review, "byDraft", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ draft_type: "author" } });

// link-arms-conflict: links sharing a name that cannot be one field. Every one of them is dropped.
@@link(Review, "mixed", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
@@link(Review, "mixed", Widgets.read, #{ id: "subject_id" });
@@link(Review, "twoProperties", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
@@link(Review, "twoProperties", Widgets.read, #{ id: "subject_id" }, #{ when: #{ tone: "warm" } });
@@link(Review, "claimedTwice", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" } });
@@link(Review, "claimedTwice", Widgets.read, #{ id: "subject_id" }, #{ when: #{ subject_type: #["widget", "author"] } });
@@link(Review, "described", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" }, description: "An author." });
@@link(Review, "described", Widgets.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "widget" }, description: "A widget." });
@@link(Review, "listed", Authors.read, #{ authorId: "subject_ids" }, #{ when: #{ subject_type: "author" } });
@@link(Review, "listed", Widgets.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "widget" } });

// A description given on one arm only is the field's.
@@link(Review, "onceDescribed", Authors.read, #{ authorId: "subject_id" }, #{ when: #{ subject_type: "author" }, description: "What the review is of." });
@@link(Review, "onceDescribed", Widgets.read, #{ id: "subject_id" }, #{ when: #{ subject_type: "widget" } });
