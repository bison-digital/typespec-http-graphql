import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

// Survivors: two roots, one with a warning, and two links.
@@queryField(Widgets.read, "widget");
@@queryField(Widgets.search, "searchWidgets");
@@link(Widget, "author", Authors.read, #{ authorId: "authorId" });
@@link(Gadget, "author", Authors.read, #{ authorId: "authorId" });

// Every way a declaration is dropped.
@@queryField(Widgets.list, "list-widgets");
@@queryField(Widgets.read, "widgetAgain");
@@queryField(Authors.read, "author");
@@queryField(Authors.byNumber, "author");
@@queryField(Widgets.exists, "widgetExists");
@@mutationField(Widgets.upload, "uploadText");
@@mutationField(Widgets.adopt, "adoptPet");
@@queryField(Widgets.export, "exportWidgets");
@@link(Widget, "touched", Widgets.touch, #{ id: "id" });
@@link(Widget, "authorByKey", Authors.read, #{ author: "authorId" });
@@link(Widget, "owner", Authors.read, #{ authorId: "ownerId" });
@@link(Widget, "authorByMistake", Authors.read, #{ authorId: "count" });
@@link(Widget, "displayName", Authors.read, #{ authorId: "authorId" });
@@link(Widget, "bad name", Authors.read, #{ authorId: "authorId" });
