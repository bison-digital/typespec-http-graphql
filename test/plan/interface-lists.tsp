import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A book and a magazine, which share a publication's lists: one bounded, one not. Four notices whose
 * stamps two bound at three and two at one, so the interface they share states no bound. Prizes, a
 * `@discriminator` base whose members share its bounded list of judges.
 */
@service
namespace Bookshop;

model Tag {
  label: string;
}

model Publication {
  /** Bounded on the property. */
  @maxItems(4) marks: Tag[];

  /** Unbounded. */
  notes: Tag[];
}

model Book extends Publication {
  @key id: string;
  title: string;
}

model Magazine extends Publication {
  @key id: string;
  issue: int32;
}

model Notice {
  @maxItems(3) stamps: Tag[];
}

model Poster {
  ...Notice;
  @key id: string;
}

model Flyer {
  ...Notice;
  @key id: string;
}

model Banner {
  ...Notice;
  @key id: string;
}

model Sticker {
  ...Notice;
  @key id: string;
}

@@maxItems(Banner.stamps, 1);
@@maxItems(Sticker.stamps, 1);

@discriminator("kind")
model Prize {
  kind: string;
  @maxItems(5) judges: Tag[];
}

model Medal extends Prize {
  kind: "medal";
  metal: string;
}

model Trophy extends Prize {
  kind: "trophy";
  height: int32;
}

@route("/books")
interface Books {
  @route("/{bookId}") @get read(@path bookId: string): Book;
}

@route("/magazines")
interface Magazines {
  @route("/{magazineId}") @get read(@path magazineId: string): Magazine;
}

@@queryField(Books.read, "book");
@@queryField(Magazines.read, "magazine");

@route("/notices")
interface Notices {
  @route("/posters/{id}") @get poster(@path id: string): Poster;
  @route("/flyers/{id}") @get flyer(@path id: string): Flyer;
  @route("/banners/{id}") @get banner(@path id: string): Banner;
  @route("/stickers/{id}") @get sticker(@path id: string): Sticker;
}

@route("/prizes")
interface Prizes {
  @route("/{prizeId}") @get read(@path prizeId: string): Prize;
}

@@queryField(Notices.poster, "poster");
@@queryField(Notices.flyer, "flyer");
@@queryField(Notices.banner, "banner");
@@queryField(Notices.sticker, "sticker");
@@queryField(Prizes.read, "prize");
