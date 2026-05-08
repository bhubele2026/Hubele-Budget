import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
  useGetForecast,
  useUpsertForecastResolution,
  useDeleteForecastResolution,
} from "@workspace/api-client-react";
import { Stack } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { formatCurrency } from "@/lib/format";
import {
  buildMissedRows,
  buildPlanRows,
  monthKeyOf,
  todayISODate,
  validateNewDate,
  type MissedRow,
  type PlanRow,
} from "@/lib/forecastBucket";

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthsAhead(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Smallest legal date the picker should allow: the day after the
 *  later of (today, originalOccurrence). Mirrors `validateNewDate`'s
 *  strictly-after rule so users can't even spin the picker to an
 *  invalid value. */
function minRescheduleDate(occurrenceDate: string, now: Date = new Date()): Date {
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  const occ = parseISODate(occurrenceDate);
  const dayAfterOcc = new Date(
    occ.getFullYear(),
    occ.getMonth(),
    occ.getDate() + 1,
  );
  return tomorrow > dayAfterOcc ? tomorrow : dayAfterOcc;
}

type Snack = {
  id: number;
  title: string;
  detail?: string;
  undoResolutionId?: string | null;
};

type SetDateTarget = {
  itemId: string;
  occurrenceDate: string;
  label: string;
  amount: number;
};

export default function ForecastScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [monthKey, setMonthKey] = useState<string>(currentMonthKey);
  const [snack, setSnack] = useState<Snack | null>(null);
  const snackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snackOpacity = useRef(new Animated.Value(0)).current;
  const [setDateTarget, setSetDateTarget] = useState<SetDateTarget | null>(
    null,
  );
  const [setDateDraft, setSetDateDraft] = useState<string>("");
  const [setDateError, setSetDateError] = useState<string | null>(null);
  // (Android-only) the native date dialog only renders while open and
  // dismisses itself on select/cancel; iOS uses the inline spinner.
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);

  const forecast = useGetForecast();
  const upsertResolution = useUpsertForecastResolution();
  const deleteResolution = useDeleteForecastResolution();

  const events = forecast.data?.events ?? [];
  const resolutions = forecast.data?.resolutions ?? [];

  const planRows = useMemo(
    () => buildPlanRows({ events, resolutions }),
    [events, resolutions],
  );
  const missedRows = useMemo(
    () => buildMissedRows({ events, resolutions, monthKey }),
    [events, resolutions, monthKey],
  );

  const monthsAvailable = useMemo(() => {
    const set = new Set<string>([currentMonthKey(), monthsAhead(1)]);
    for (const ev of events) set.add(monthKeyOf(ev.date));
    for (const r of resolutions) {
      if (r.occurrenceDate) set.add(monthKeyOf(r.occurrenceDate));
      // Include the destination month of any reschedule so a moved
      // occurrence stays reachable in the month cycler even when the
      // original event/resolution months are earlier (avoids a UX
      // where successful reschedules appear to "disappear").
      if (r.rescheduledTo) set.add(monthKeyOf(r.rescheduledTo));
    }
    return Array.from(set).sort();
  }, [events, resolutions]);

  const monthIdx = monthsAvailable.indexOf(monthKey);
  const planRowsForMonth = useMemo(
    () =>
      planRows
        .filter(
          (p) =>
            (p.status === "pending" || p.status === "future") &&
            monthKeyOf(p.date) === monthKey,
        )
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    [planRows, monthKey],
  );

  const showSnack = (s: Omit<Snack, "id">) => {
    if (snackTimeout.current) clearTimeout(snackTimeout.current);
    const id = Date.now();
    setSnack({ id, ...s });
    Animated.timing(snackOpacity, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
    snackTimeout.current = setTimeout(() => dismissSnack(), 6000);
  };
  const dismissSnack = () => {
    Animated.timing(snackOpacity, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setSnack(null));
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const onUndo = (id: string) => {
    deleteResolution.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          showSnack({ title: "Undone" });
        },
      },
    );
  };

  const onMarkMissed = (row: PlanRow) => {
    if (row.status !== "pending" && row.status !== "future") return;
    upsertResolution.mutate(
      {
        data: {
          status: "missed",
          recurringItemId: row.itemId,
          occurrenceDate: row.occurrenceDate,
        },
      },
      {
        onSuccess: (created) => {
          invalidate();
          showSnack({
            title: "Marked missed",
            detail: `${row.label || "Occurrence"} · ${formatShortDate(row.date)}`,
            undoResolutionId: created?.id ?? null,
          });
        },
      },
    );
  };

  const openSetNewDateForPlan = (row: PlanRow) => {
    setSetDateTarget({
      itemId: row.itemId,
      occurrenceDate: row.occurrenceDate,
      label: row.label,
      amount: row.amount,
    });
    setSetDateDraft("");
    setSetDateError(null);
  };
  const openSetNewDateForMissed = (row: MissedRow) => {
    setSetDateTarget({
      itemId: row.itemId,
      occurrenceDate: row.occurrenceDate,
      label: row.label,
      amount: row.amount,
    });
    setSetDateDraft("");
    setSetDateError(null);
  };
  const closeSetDate = () => {
    setSetDateTarget(null);
    setSetDateDraft("");
    setSetDateError(null);
    setAndroidPickerOpen(false);
  };
  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === "android") setAndroidPickerOpen(false);
    if (event.type === "dismissed") return;
    if (!picked) return;
    const iso = todayISODate(picked);
    setSetDateDraft(iso);
    setSetDateError(validateNewDate(iso, setDateTarget?.occurrenceDate ?? ""));
  };
  const onSaveNewDate = () => {
    if (!setDateTarget) return;
    const err = validateNewDate(setDateDraft, setDateTarget.occurrenceDate);
    if (err) {
      setSetDateError(err);
      return;
    }
    upsertResolution.mutate(
      {
        data: {
          status: "rescheduled",
          recurringItemId: setDateTarget.itemId,
          occurrenceDate: setDateTarget.occurrenceDate,
          rescheduledTo: setDateDraft,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          showSnack({
            title: `Moved to ${formatShortDate(setDateDraft)}`,
            detail: setDateTarget.label || undefined,
          });
          closeSetDate();
        },
        onError: (e: unknown) => {
          const msg = (e as Error).message ?? "Failed to move occurrence";
          setSetDateError(msg);
        },
      },
    );
  };

  const onSkipFromMissed = (row: MissedRow) => {
    upsertResolution.mutate(
      {
        data: {
          status: "skipped",
          recurringItemId: row.itemId,
          occurrenceDate: row.occurrenceDate,
        },
      },
      {
        onSuccess: (created) => {
          invalidate();
          showSnack({
            title: "Skipped",
            detail: `${row.label || "Occurrence"} · ${formatShortDate(row.occurrenceDate)}`,
            undoResolutionId: created?.id ?? null,
          });
        },
      },
    );
  };

  if (forecast.isLoading) {
    return (
      <SafeAreaView
        edges={["top"]}
        style={[styles.safe, { backgroundColor: colors.background }]}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ paddingTop: 60, alignItems: "center" }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 160 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Forecast</Text>

        <View style={styles.monthCycler}>
          <Pressable
            onPress={() => {
              if (monthIdx > 0) setMonthKey(monthsAvailable[monthIdx - 1]);
            }}
            disabled={monthIdx <= 0}
            accessibilityLabel="Previous month"
            testID="forecast-prev-month"
            style={[
              styles.cyclerBtn,
              {
                borderColor: colors.border,
                opacity: monthIdx <= 0 ? 0.4 : 1,
              },
            ]}
          >
            <Text style={{ color: colors.foreground, fontSize: 18 }}>‹</Text>
          </Pressable>
          <Text
            style={[styles.cyclerLabel, { color: colors.mutedForeground }]}
            testID="forecast-month-label"
          >
            {monthKey}
          </Text>
          <Pressable
            onPress={() => {
              if (monthIdx < monthsAvailable.length - 1) {
                setMonthKey(monthsAvailable[monthIdx + 1]);
              }
            }}
            disabled={monthIdx >= monthsAvailable.length - 1}
            accessibilityLabel="Next month"
            testID="forecast-next-month"
            style={[
              styles.cyclerBtn,
              {
                borderColor: colors.border,
                opacity: monthIdx >= monthsAvailable.length - 1 ? 0.4 : 1,
              },
            ]}
          >
            <Text style={{ color: colors.foreground, fontSize: 18 }}>›</Text>
          </Pressable>
        </View>

        <View
          style={[
            styles.section,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          testID="forecast-pending-section"
        >
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            Pending in {monthKey}
          </Text>
          {planRowsForMonth.length === 0 ? (
            <Text
              style={{
                color: colors.mutedForeground,
                paddingVertical: 12,
                textAlign: "center",
              }}
            >
              Nothing pending this month.
            </Text>
          ) : (
            <View style={{ marginTop: 4 }}>
              {planRowsForMonth.map((row, i) => (
                <View
                  key={`${row.itemId}|${row.date}`}
                  style={[
                    styles.row,
                    {
                      borderBottomColor: colors.border,
                      borderBottomWidth:
                        i === planRowsForMonth.length - 1
                          ? 0
                          : StyleSheet.hairlineWidth,
                    },
                  ]}
                  testID={`plan-row-${row.itemId}-${row.date}`}
                >
                  <View style={styles.rowMain}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={[styles.rowLabel, { color: colors.foreground }]}
                      >
                        {row.label || "—"}
                      </Text>
                      <Text
                        style={[
                          styles.rowMeta,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {formatShortDate(row.date)}
                        {row.status === "future" ? " · upcoming" : " · pending"}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.rowAmount,
                        {
                          color:
                            row.amount < 0
                              ? colors.destructive
                              : colors.primary,
                        },
                      ]}
                    >
                      {formatCurrency(row.amount)}
                    </Text>
                  </View>
                  <View style={styles.rowActions}>
                    <ActionButton
                      label="Mark missed"
                      onPress={() => onMarkMissed(row)}
                      disabled={upsertResolution.isPending}
                      testID={`plan-mark-missed-${row.itemId}-${row.date}`}
                    />
                    <ActionButton
                      label="Set new date"
                      onPress={() => openSetNewDateForPlan(row)}
                      disabled={upsertResolution.isPending}
                      testID={`plan-set-new-date-${row.itemId}-${row.date}`}
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        {missedRows.length > 0 && (
          <View
            style={[
              styles.section,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            testID="forecast-missed-section"
          >
            <Text
              style={[styles.sectionLabel, { color: colors.mutedForeground }]}
            >
              Missed in {monthKey} · {missedRows.length}
            </Text>
            <View style={{ marginTop: 4 }}>
              {missedRows.map((row, i) => (
                <View
                  key={row.resolutionId}
                  style={[
                    styles.row,
                    {
                      borderBottomColor: colors.border,
                      borderBottomWidth:
                        i === missedRows.length - 1
                          ? 0
                          : StyleSheet.hairlineWidth,
                    },
                  ]}
                  testID={`missed-row-${row.resolutionId}`}
                >
                  <View style={styles.rowMain}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={[styles.rowLabel, { color: colors.foreground }]}
                      >
                        {row.label || "—"}
                      </Text>
                      <Text
                        style={[
                          styles.rowMeta,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {formatShortDate(row.occurrenceDate)} · missed
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.rowAmount,
                        {
                          color:
                            row.amount < 0
                              ? colors.destructive
                              : colors.primary,
                        },
                      ]}
                    >
                      {formatCurrency(row.amount)}
                    </Text>
                  </View>
                  <View style={styles.rowActions}>
                    <ActionButton
                      label="Set new date"
                      onPress={() => openSetNewDateForMissed(row)}
                      disabled={upsertResolution.isPending}
                      testID={`missed-set-new-date-${row.resolutionId}`}
                    />
                    <ActionButton
                      label="Skip"
                      onPress={() => onSkipFromMissed(row)}
                      disabled={upsertResolution.isPending}
                      testID={`missed-skip-${row.resolutionId}`}
                    />
                    <ActionButton
                      label="Undo"
                      onPress={() => onUndo(row.resolutionId)}
                      disabled={deleteResolution.isPending}
                      testID={`missed-undo-${row.resolutionId}`}
                    />
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {snack && (
        <Animated.View
          style={[
            styles.snack,
            {
              backgroundColor: colors.foreground,
              opacity: snackOpacity,
            },
          ]}
          testID="forecast-snackbar"
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.snackTitle, { color: colors.background }]}>
              {snack.title}
            </Text>
            {snack.detail && (
              <Text
                style={[styles.snackDetail, { color: colors.background }]}
                numberOfLines={1}
              >
                {snack.detail}
              </Text>
            )}
          </View>
          {snack.undoResolutionId && (
            <Pressable
              onPress={() => {
                const id = snack.undoResolutionId!;
                dismissSnack();
                onUndo(id);
              }}
              testID="forecast-snackbar-undo"
              style={styles.snackBtn}
            >
              <Text
                style={[
                  styles.snackBtnText,
                  { color: colors.background },
                ]}
              >
                UNDO
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={dismissSnack}
            accessibilityLabel="Dismiss"
            style={styles.snackBtn}
          >
            <Text style={[styles.snackBtnText, { color: colors.background }]}>
              ✕
            </Text>
          </Pressable>
        </Animated.View>
      )}

      <Modal
        animationType="fade"
        transparent
        visible={setDateTarget !== null}
        onRequestClose={closeSetDate}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Move to a future date
            </Text>
            {setDateTarget && (
              <>
                <Text
                  style={[
                    styles.modalSubtitle,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {setDateTarget.label || "—"} ·{" "}
                  {formatShortDate(setDateTarget.occurrenceDate)} ·{" "}
                  {formatCurrency(setDateTarget.amount)}
                </Text>
                {(() => {
                  const minDate = minRescheduleDate(
                    setDateTarget.occurrenceDate,
                  );
                  const valueDate = setDateDraft
                    ? parseISODate(setDateDraft)
                    : minDate;
                  if (Platform.OS === "ios") {
                    return (
                      <View testID="set-new-date-picker">
                        <DateTimePicker
                          mode="date"
                          display="spinner"
                          value={valueDate}
                          minimumDate={minDate}
                          onChange={onPickerChange}
                          themeVariant={
                            colors.background === "#000000" ? "dark" : undefined
                          }
                        />
                      </View>
                    );
                  }
                  return (
                    <>
                      <Pressable
                        onPress={() => setAndroidPickerOpen(true)}
                        style={[
                          styles.pickerBtn,
                          {
                            borderColor: colors.border,
                            backgroundColor: colors.background,
                          },
                        ]}
                        testID="set-new-date-open-picker"
                      >
                        <Text
                          style={{
                            color: setDateDraft
                              ? colors.foreground
                              : colors.mutedForeground,
                            fontSize: 16,
                          }}
                        >
                          {setDateDraft
                            ? formatShortDate(setDateDraft)
                            : "Pick a date"}
                        </Text>
                      </Pressable>
                      {androidPickerOpen && (
                        <DateTimePicker
                          mode="date"
                          display="default"
                          value={valueDate}
                          minimumDate={minDate}
                          onChange={onPickerChange}
                          testID="set-new-date-picker"
                        />
                      )}
                    </>
                  );
                })()}
                <Text
                  style={[
                    styles.modalHint,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Must be after today and after the original occurrence.
                </Text>
                {setDateError && (
                  <Text
                    style={[styles.modalError, { color: colors.destructive }]}
                    testID="set-new-date-error"
                  >
                    {setDateError}
                  </Text>
                )}
                <View style={styles.modalBtnRow}>
                  <Pressable
                    onPress={closeSetDate}
                    style={[
                      styles.modalBtn,
                      { borderColor: colors.border },
                    ]}
                    testID="set-new-date-cancel"
                  >
                    <Text style={{ color: colors.foreground }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={onSaveNewDate}
                    disabled={upsertResolution.isPending}
                    style={[
                      styles.modalBtnPrimary,
                      { backgroundColor: colors.primary },
                    ]}
                    testID="set-new-date-save"
                  >
                    <Text style={{ color: colors.primaryForeground }}>
                      Move occurrence
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ActionButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      testID={props.testID}
      style={[
        styles.actionBtn,
        {
          borderColor: colors.border,
          backgroundColor: colors.background,
          opacity: props.disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text style={{ color: colors.foreground, fontSize: 12 }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  h1: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    marginBottom: 16,
  },
  monthCycler: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginBottom: 16,
  },
  cyclerBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 999,
    minWidth: 36,
    alignItems: "center",
  },
  cyclerLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    minWidth: 80,
    textAlign: "center",
  },
  section: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  sectionLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  row: {
    paddingVertical: 12,
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  rowMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
  },
  rowAmount: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
  rowActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    flexWrap: "wrap",
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 999,
  },
  snack: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 96,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  snackTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  snackDetail: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 2,
    opacity: 0.85,
  },
  snackBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  snackBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    letterSpacing: 0.5,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  modalSubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  pickerBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  modalHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  modalError: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  modalBtnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 8,
  },
  modalBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
  },
  modalBtnPrimary: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
});
