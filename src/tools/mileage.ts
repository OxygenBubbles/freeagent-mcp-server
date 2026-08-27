import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createMileageExpense,
  getMileageRate,
  handleFAError,
} from "../services/freeagent.js";
import {
  calculateDistance,
  isDistanceConfigured,
} from "../services/distance.js";
import {
  calculateHMRCMileage,
  type HMRCRates,
} from "../utils/mileageCalc.js";
import {
  HMRC_RATE_HIGH_PENCE,
  HMRC_RATE_LOW_PENCE,
  HMRC_THRESHOLD_MILES,
} from "../constants.js";
import { dateSchema, invalid } from "./respond.js";

// 249 is "Mileage" in FreeAgent's standard chart of accounts. The previous
// default (311) does not exist there, so every mileage claim was rejected.
function getMileageCategoryUrl(): string {
  return process.env.MILEAGE_CATEGORY_URL ?? "/v2/categories/249";
}

function getDefaultRate(): number | null {
  const env = process.env.MILEAGE_RATE_PENCE;
  if (env) {
    const rate = parseFloat(env);
    if (!isNaN(rate) && rate > 0) return rate;
  }
  return null;
}

function readPositiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `Warning: ${name}="${raw}" is not a valid positive number; using default ${fallback}.\n`
    );
    return fallback;
  }
  return n;
}

function getHMRCRates(): HMRCRates {
  return {
    highPence:      readPositiveEnv("HMRC_RATE_HIGH_PENCE", HMRC_RATE_HIGH_PENCE),
    lowPence:       readPositiveEnv("HMRC_RATE_LOW_PENCE",  HMRC_RATE_LOW_PENCE),
    thresholdMiles: readPositiveEnv("HMRC_THRESHOLD_MILES", HMRC_THRESHOLD_MILES),
  };
}

export function registerMileageTools(server: McpServer): void {
  server.registerTool(
    "freeagent_create_mileage_expense",
    {
      description:
        "Create a mileage expense in FreeAgent. " +
        "Provide either origin + destination (requires ORS_API_KEY or GOOGLE_MAPS_API_KEY for distance lookup) " +
        "or manualMiles for the journey distance. Set roundTrip=true to double the distance.\n\n" +
        "The claim value is calculated by FreeAgent from the mileage rate configured on the account " +
        "(this is what HMRC reporting in FreeAgent uses). ratePence / cumulativeMilesYTD only produce " +
        "an advisory estimate in the response for cross-checking — they do not change what is filed.",
      inputSchema: z
        .object({
          datedOn: dateSchema("Journey date YYYY-MM-DD"),
          description: z
            .string()
            .min(1)
            .max(500)
            .describe("Journey description (e.g. 'Office to client site, quarterly review')"),
          origin: z
            .string()
            .max(500)
            .optional()
            .describe("Origin address. Requires distance API key. Omit if providing manualMiles."),
          destination: z
            .string()
            .max(500)
            .optional()
            .describe("Destination address. Requires distance API key. Omit if providing manualMiles."),
          manualMiles: z
            .number()
            .positive()
            .optional()
            .describe("Journey distance in miles (use instead of origin/destination)"),
          roundTrip: z
            .boolean()
            .default(false)
            .describe("Double the distance for a return journey"),
          ratePence: z
            .number()
            .positive()
            .optional()
            .describe(
              "Pence per mile (e.g. 45) used only for the advisory estimate in the response. " +
              "FreeAgent applies the mileage rate configured on the account when filing the claim."
            ),
          vehicleType: z
            .enum(["Car", "Motorcycle", "Bicycle"])
            .default("Car")
            .describe("Vehicle used for the journey (required by FreeAgent's mileage category)"),
          engineType: z
            .enum([
              "Petrol",
              "Diesel",
              "LPG",
              "Electric",
              "Electric (Home charger)",
              "Electric (Public charger)",
            ])
            .optional()
            .describe(
              "Fuel or power type. Needed with engineSize to reclaim the VAT on the fuel element " +
              "of the claim — without them FreeAgent has nothing to calculate it from."
            ),
          engineSize: z
            .string()
            .max(50)
            .optional()
            .describe(
              "Engine size band as FreeAgent labels it (e.g. 'Up to 1400cc', '1401-2000cc', " +
              "'Over 2000cc', 'All'). The valid bands vary by date and engine type."
            ),
          haveVatReceipt: z
            .boolean()
            .optional()
            .describe("Whether a VAT receipt for the fuel was kept — required to reclaim the VAT"),
          project: z
            .string()
            .regex(
              /^(?:https:\/\/api\.freeagent\.com)?\/v2\/projects\/\d+$/,
              "Must be a FreeAgent project path like /v2/projects/123"
            )
            .optional()
            .describe("FreeAgent project URL to tag the journey against"),
          rebillType: z
            .enum(["cost", "markup", "price"])
            .optional()
            .describe(
              "How to rebill this to the client — 'cost' bills it on at cost, 'markup' adds a " +
              "percentage, 'price' charges a fixed price. Requires project. Without it the expense " +
              "is attributed to the project but never queued to bill on."
            ),
          rebillFactor: z
            .string()
            .regex(/^\d+(\.\d+)?$/, "Numeric string, e.g. '15.0'")
            .optional()
            .describe("Markup percentage or fixed price — required for markup/price"),
          cumulativeMilesYTD: z
            .number()
            .min(0)
            .optional()
            .describe(
              "Cumulative business miles already claimed this tax year. " +
              "Used for HMRC threshold logic (high rate → low rate at threshold). " +
              "Only relevant when ratePence is not set."
            ),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Three-letter uppercase ISO 4217 code, e.g. GBP")
            .default("GBP")
            .describe("ISO 4217 currency code (default GBP)"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        if (args.rebillType && !args.project) {
          return invalid(
            "rebillType needs a project — FreeAgent rebills a journey to the project it is tagged against."
          );
        }
        if (
          (args.rebillType === "markup" || args.rebillType === "price") &&
          !args.rebillFactor
        ) {
          return invalid(
            `rebillType '${args.rebillType}' needs rebillFactor (the markup percentage or fixed price).`
          );
        }

        if (Boolean(args.engineType) !== Boolean(args.engineSize)) {
          return invalid(
            "engineType and engineSize go together — FreeAgent needs both to work out the VAT on the fuel."
          );
        }
        if (args.haveVatReceipt && !args.engineType) {
          return invalid(
            "haveVatReceipt needs engineType and engineSize — without them FreeAgent cannot calculate the reclaimable VAT, so recording the receipt alone achieves nothing."
          );
        }

        // ── Resolve distance ──────────────────────────────────────────────
        let miles: number;
        let journeyDetail: string;

        if (args.manualMiles) {
          miles = args.manualMiles;
          journeyDetail = `${miles} miles (manual)`;
        } else if (args.origin && args.destination) {
          if (!isDistanceConfigured()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: No distance API configured. Set ORS_API_KEY or GOOGLE_MAPS_API_KEY, or provide manualMiles.",
                },
              ],
              isError: true,
            };
          }
          const result = await calculateDistance(args.origin, args.destination);
          miles = result.distanceMiles;
          journeyDetail = `${args.origin} to ${args.destination} = ${miles} miles (${result.provider})`;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Error: Provide either manualMiles or both origin and destination.",
              },
            ],
            isError: true,
          };
        }

        if (args.roundTrip) {
          miles = miles * 2;
          journeyDetail += " (round trip)";
        }

        // ── Estimate ──────────────────────────────────────────────────────
        // FreeAgent files the claim at the rate configured on the account, so
        // ask it what that rate is rather than guessing and reporting the
        // difference afterwards. A caller-supplied ratePence still wins, and
        // MILEAGE_RATE_PENCE / the HMRC bands remain the fallback for an
        // account whose settings cannot be read.
        let estimatePounds: string;
        let breakdown: string;
        let ratePence: number | undefined;
        let estimateSource:
          | "argument"
          | "freeagent_mileage_settings"
          | "MILEAGE_RATE_PENCE"
          | "hmrc_defaults";
        const notes: string[] = [];

        const published = args.ratePence
          ? null
          : await getMileageRate(args.datedOn, args.vehicleType);

        const explicitRate = args.ratePence ?? getDefaultRate();

        if (args.ratePence) {
          ratePence = args.ratePence;
          estimatePounds = (Math.round(miles * ratePence) / 100).toFixed(2);
          breakdown = `${miles} miles @ ${ratePence}p/mile`;
          estimateSource = "argument";
        } else if (published) {
          estimateSource = "freeagent_mileage_settings";
          const banded =
            published.subsequentRatePence !== undefined &&
            published.thresholdMiles !== undefined;
          if (banded) {
            if (args.cumulativeMilesYTD === undefined) {
              notes.push(
                `The rate steps down after ${published.thresholdMiles} miles in the tax year. ` +
                "No cumulativeMilesYTD was given, so the estimate assumes none claimed yet; " +
                "FreeAgent's own figure accounts for the miles already filed."
              );
            }
            const calc = calculateHMRCMileage(miles, args.cumulativeMilesYTD ?? 0, {
              highPence: published.initialRatePence,
              lowPence: published.subsequentRatePence!,
              thresholdMiles: published.thresholdMiles!,
            });
            estimatePounds = calc.amountPounds;
            breakdown = `${calc.breakdown} (FreeAgent mileage settings)`;
            if (calc.type === "single") ratePence = calc.ratePence;
          } else {
            ratePence = published.initialRatePence;
            estimatePounds = (Math.round(miles * ratePence) / 100).toFixed(2);
            breakdown = `${miles} miles @ ${ratePence}p/mile (FreeAgent mileage settings)`;
          }
        } else if (explicitRate) {
          ratePence = explicitRate;
          estimatePounds = (Math.round(miles * ratePence) / 100).toFixed(2);
          breakdown = `${miles} miles @ ${ratePence}p/mile (MILEAGE_RATE_PENCE)`;
          estimateSource = "MILEAGE_RATE_PENCE";
        } else {
          const rates = getHMRCRates();
          const calc = calculateHMRCMileage(
            miles,
            args.cumulativeMilesYTD ?? 0,
            rates
          );
          estimatePounds = calc.amountPounds;
          breakdown = calc.breakdown;
          if (calc.type === "single") ratePence = calc.ratePence;
          estimateSource = "hmrc_defaults";
        }

        // ── File the claim ────────────────────────────────────────────────
        const expense = await createMileageExpense({
          categoryUrl: getMileageCategoryUrl(),
          datedOn: args.datedOn,
          description: `${args.description} — ${journeyDetail}`,
          miles,
          vehicleType: args.vehicleType,
          currency: args.currency,
          engineType: args.engineType,
          engineSize: args.engineSize,
          haveVatReceipt: args.haveVatReceipt,
          projectUrl: args.project,
          rebillType: args.rebillType,
          rebillFactor: args.rebillFactor,
        });

        // FreeAgent records claims as negative (money owed to the claimant).
        const filedAmount = expense.gross_value;
        const filedMagnitude = Math.abs(parseFloat(filedAmount)).toFixed(2);
        if (filedMagnitude !== estimatePounds) {
          notes.push(
            `FreeAgent filed £${filedMagnitude} using the mileage rate configured on the account; ` +
            `the estimate from ${breakdown} was £${estimatePounds}.`
          );
        }
        if (estimateSource === "hmrc_defaults" || estimateSource === "MILEAGE_RATE_PENCE") {
          notes.push(
            "FreeAgent's own mileage settings could not be read, so the estimate uses " +
            (estimateSource === "MILEAGE_RATE_PENCE"
              ? "MILEAGE_RATE_PENCE."
              : "the built-in HMRC rates.")
          );
        }


        const payload = {
          success: true,
          expenseId: expense.id,
          expenseUrl: expense.url,
          miles,
          vehicleType: args.vehicleType,
          amount: filedAmount,
          rateApplied: expense.reclaim_mileage_rate ?? null,
          estimate: estimatePounds,
          estimateBasis: breakdown,
          estimateSource,
          estimateRatePence: ratePence,
          journey: journeyDetail,
          engineType: args.engineType ?? null,
          engineSize: args.engineSize ?? null,
          haveVatReceipt: args.haveVatReceipt ?? null,
          project: args.project ?? null,
          rebill: args.rebillType
            ? { type: args.rebillType, factor: args.rebillFactor ?? null }
            : null,
          cumulativeMilesAfter:
            args.cumulativeMilesYTD === undefined
              ? undefined
              : args.cumulativeMilesYTD + miles,
          notes,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: {
            success: true,
            expenseId: expense.id,
            miles,
            amount: filedAmount,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );
}
