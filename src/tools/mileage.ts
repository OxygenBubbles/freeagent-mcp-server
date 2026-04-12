import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createExpense, handleFAError } from "../services/freeagent.js";
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

function getMileageCategoryUrl(): string {
  return process.env.MILEAGE_CATEGORY_URL ?? "/v2/categories/311";
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
        "Rate: pass ratePence to set the per-mile rate explicitly (e.g. 45 for 45p/mile). " +
        "If omitted, defaults to the MILEAGE_RATE_PENCE env var, or HMRC approved rates " +
        "(configurable via HMRC_RATE_HIGH_PENCE / HMRC_RATE_LOW_PENCE / HMRC_THRESHOLD_MILES env vars, " +
        "defaulting to 45p/25p at 10,000 miles — pass cumulativeMilesYTD to enable threshold logic).",
      inputSchema: z
        .object({
          datedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Journey date YYYY-MM-DD"),
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
              "Pence per mile (e.g. 45). If omitted, uses MILEAGE_RATE_PENCE env var " +
              "or HMRC rates (configurable via env vars, defaults to 45p/25p with threshold logic)."
            ),
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
            .length(3)
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

        // ── Calculate rate and amount ─────────────────────────────────────
        let amountPounds: string;
        let breakdown: string;
        let ratePence: number | undefined;

        if (args.ratePence) {
          // Explicit rate
          ratePence = args.ratePence;
          const amountPence = Math.round(miles * ratePence);
          amountPounds = (amountPence / 100).toFixed(2);
          breakdown = `${miles} miles @ ${ratePence}p/mile`;
        } else {
          const envRate = getDefaultRate();
          if (envRate) {
            // Env var flat rate
            ratePence = envRate;
            const amountPence = Math.round(miles * ratePence);
            amountPounds = (amountPence / 100).toFixed(2);
            breakdown = `${miles} miles @ ${ratePence}p/mile (MILEAGE_RATE_PENCE)`;
          } else {
            // HMRC threshold logic — load configurable rates once
            const rates = getHMRCRates();
            const cumulative = args.cumulativeMilesYTD ?? 0;
            const calc = calculateHMRCMileage(miles, cumulative, rates);
            amountPounds = calc.amountPounds;
            breakdown = calc.breakdown;

            if (calc.type === "split") {
              const expense = await createExpense({
                categoryUrl: getMileageCategoryUrl(),
                datedOn: args.datedOn,
                description: `[MILEAGE] [${miles} miles] ${args.description} — ${journeyDetail}. ${calc.highMiles} mi @ ${rates.highPence}p + ${calc.lowMiles} mi @ ${rates.lowPence}p (crosses ${rates.thresholdMiles.toLocaleString()}-mile threshold)`,
                grossValue: amountPounds,
                currency: args.currency,
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        success: true,
                        expenseId: expense.id,
                        miles,
                        amount: amountPounds,
                        breakdown,
                        journey: journeyDetail,
                        cumulativeMilesAfter: cumulative + miles,
                      },
                      null,
                      2
                    ),
                  },
                ],
                structuredContent: {
                  success: true,
                  expenseId: expense.id,
                  miles,
                  amount: amountPounds,
                },
              };
            }

            if (calc.type === "single") {
              ratePence = calc.ratePence;
            }
          }
        }

        const expense = await createExpense({
          categoryUrl: getMileageCategoryUrl(),
          datedOn: args.datedOn,
          description: `[MILEAGE] [${miles} miles] ${args.description} — ${journeyDetail}. ${breakdown!}`,
          grossValue: amountPounds!,
          currency: args.currency,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  expenseId: expense.id,
                  miles,
                  ratePence,
                  amount: amountPounds,
                  breakdown,
                  journey: journeyDetail,
                  cumulativeMilesAfter: args.cumulativeMilesYTD
                    ? args.cumulativeMilesYTD + miles
                    : undefined,
                },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            success: true,
            expenseId: expense.id,
            miles,
            amount: amountPounds,
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
