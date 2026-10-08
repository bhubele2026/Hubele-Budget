import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiClientReactLedgerSrc = path.resolve(apiClientReactSrc, "ledger");
const apiClientReactFeaturesSrc = path.resolve(apiClientReactSrc, "features");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
      // (PR14 review M4) Operations tagged chase-ledger are generated into
      // their own module (below), so the landing chunk never carries them.
      filters: { mode: "exclude", tags: ["chase-ledger", "ai-stream"] },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  // (PR14 review M4) The Chase page's own operations (ledger, balances, review
  // by filter, UI preferences), tagged chase-ledger in the spec and exported as
  // `@workspace/api-client-react/ledger`. Rollup keeps a module shared with the
  // landing route whole in the entry chunk, so hooks only the lazy Chase page
  // uses belong in a module only that page imports.
  "api-client-react-ledger": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
      filters: { mode: "include", tags: ["chase-ledger"] },
    },
    output: {
      workspace: apiClientReactLedgerSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
        // "Load more": an infinite-query hook keyed on the opaque `cursor` param.
        operations: {
          getTransactionsLedger: {
            query: {
              useQuery: true,
              useInfinite: true,
              useInfiniteQueryParam: "cursor",
              // The client package names react-query as `catalog:`, which orval
              // cannot read a version from, so it would emit v4 infinite types
              // (an untyped pageParam). The app runs v5; say so for this
              // operation only.
              version: 5,
            },
          },
        },
      },
    },
  },
  // (C0) The fold-in operations (parity review F1-F10), tagged `features` in
  // the spec and exported as `@workspace/api-client-react/features`, for the
  // same reason as the ledger module above: the main module lives in the entry
  // chunk, so every hook a lazy page starts using from it grows the landing JS.
  // Unlike chase-ledger they are NOT excluded from the main module yet — the
  // frozen h2 app imports them from it until it is deleted at the switch; then
  // add "features" to the main config's exclude list. The h2budget app imports
  // them from here only (`featuresImportGraph.test.ts` holds it to that).
  "api-client-react-features": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
      filters: { mode: "include", tags: ["features"] },
    },
    output: {
      workspace: apiClientReactFeaturesSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
