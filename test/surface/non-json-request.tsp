import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

@@queryField(Widgets.read, "widget");
@@mutationField(Widgets.upload, "uploadText");
@@mutationField(Widgets.form, "uploadForm");
@@mutationField(Widgets.xml, "uploadXml");
@@mutationField(Widgets.blob, "uploadBlob");
// JSON beside XML: the resolver sends JSON, so this is servable.
@@mutationField(Widgets.either, "uploadEither");
