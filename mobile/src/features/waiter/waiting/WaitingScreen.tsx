import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { toApiError } from "../../../api/client";
import {
  addWaiting,
  assignWaiting,
  cancelWaiting,
  type WaitingEntry,
} from "../../../api/endpoints/waitingList";
import { qk } from "../../../api/queryKeys";
import { AppButton } from "../../../components/AppButton";
import { AppText } from "../../../components/AppText";
import { AppTextField } from "../../../components/AppTextField";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { ConnectionPill } from "../../../components/ConnectionPill";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { IconButton } from "../../../components/IconButton";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { OfflineBanner } from "../../../components/OfflineBanner";
import { QuantityStepper } from "../../../components/QuantityStepper";
import { ScreenHeader } from "../../../components/ScreenHeader";
import { ScreenScaffold } from "../../../components/ScreenScaffold";
import { useToast } from "../../../components/Toast";
import type { Resource } from "../../../domain/types";
import { colors, radii, spacing, touch } from "../../../theme/tokens";
import { errorMessage } from "../../../utils/errorMessage";
import { haptic } from "../../../utils/haptics";
import { SheetModal } from "../../common/SheetModal";
import { useSharedNow } from "../../common/useSharedNow";
import { useResources } from "../queries";
import { freeTablesByGroup, waitText } from "./waitingModel";
import { useWaitingList } from "./useWaiting";

const NAME_MAX = 40;

/** SCR-W-08 Lista de espera: add, assign a free table (-> its ticket -> menu), remove with a 5 s undo. */
export function WaitingScreen() {
  const { t } = useTranslation("mobile");
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useWaitingList();
  const now = useSharedNow(true, true); // device clock: compared with the fetch time
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<WaitingEntry | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.waiting });

  const remove = async (e: WaitingEntry) => {
    try {
      await cancelWaiting(e.id);
    } catch (err) {
      toast.show({ tone: "error", title: errorMessage(err) });
      return;
    }
    haptic.warning();
    void refresh();
    toast.show({
      tone: "info",
      title: t("waiter.waiting.removed", { name: e.party_name }),
      durationMs: 5000,
      action: {
        label: t("waiter.waiting.undo"),
        // ponytail: CANCELLED is final on the server; undo re-adds the same party at the END of the queue (position is lost)
        onPress: () => {
          addWaiting({
            party_name: e.party_name,
            party_size: e.party_size,
            ...(e.notes ? { notes: e.notes } : {}),
          })
            .then(() =>
              toast.show({
                tone: "success",
                title: t("waiter.waiting.restored", { name: e.party_name }),
              }),
            )
            .catch((er) =>
              toast.show({ tone: "error", title: errorMessage(er) }),
            )
            .finally(() => void refresh());
        },
      },
    });
  };

  let body;
  if (list.isPending && !list.data)
    body = <LoadingSkeleton variant="list" count={4} />;
  else if (!list.data)
    body = <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  else if (list.entries.length === 0)
    body = (
      <EmptyState
        icon="account-clock-outline"
        title={t("waiter.waiting.emptyTitle")}
        message={t("waiter.waiting.emptyBody")}
        testID="waiting-empty"
      />
    );
  else
    body = (
      <FlatList
        testID="waiting-list"
        data={list.entries}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => void list.refetch()}
            tintColor={colors.primaryText}
            colors={[colors.primary]}
          />
        }
        renderItem={({ item: e }) => (
          <Pressable
            testID={`waiting-row-${e.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${e.party_name}, ${t("waiter.waiting.people", { n: e.party_size })}`}
            accessibilityHint={t("waiter.waiting.remove")}
            onLongPress={() => void remove(e)}
            style={styles.row}
          >
            <View style={styles.rowText}>
              <AppText variant="bodyLg" bold numberOfLines={1}>
                {e.party_name}
              </AppText>
              <AppText variant="label" color={colors.textSecondary}>
                {`${t("waiter.waiting.people", { n: e.party_size })} · ${t("waiter.waiting.wait", { time: waitText(e.wait_seconds, list.dataUpdatedAt, now) })}`}
              </AppText>
              <View style={styles.chip}>
                <AppText variant="caption" bold color={colors.info}>
                  {t(`waiter.waiting.status.${e.status}`, {
                    defaultValue: e.status,
                  })}
                </AppText>
              </View>
            </View>
            <IconButton
              icon="close"
              accessibilityLabel={`${t("waiter.waiting.remove")} ${e.party_name}`}
              onPress={() => void remove(e)}
              testID={`waiting-remove-${e.id}`}
            />
            <AppButton
              label={t("waiter.waiting.assign")}
              onPress={() => setAssigning(e)}
              testID={`waiting-assign-${e.id}`}
            />
          </Pressable>
        )}
      />
    );

  return (
    <ScreenScaffold
      testID="screen-waiting"
      padded={false}
      header={
        <ScreenHeader
          title={t("waiter.waiting.title")}
          onBack={() =>
            router.canGoBack() ? router.back() : router.replace("/floor")
          }
          right={
            <View style={styles.headRight}>
              <AppButton
                label={t("waiter.waiting.add")}
                icon="plus"
                onPress={() => setAdding(true)}
                testID="waiting-add"
              />
              <ConnectionPill />
            </View>
          }
        />
      }
      banner={<OfflineBanner />}
    >
      {body}
      <AddSheet
        visible={adding}
        onClose={() => setAdding(false)}
        onSaved={() => void refresh()}
      />
      <AssignSheet entry={assigning} onClose={() => setAssigning(null)} />
    </ScreenScaffold>
  );
}

function AddSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("mobile");
  const [name, setName] = useState("");
  const [size, setSize] = useState(2);
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () =>
      addWaiting({
        party_name: name.trim().slice(0, NAME_MAX),
        party_size: size,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: () => {
      haptic.success();
      setName("");
      setSize(2);
      setNotes("");
      onSaved();
      onClose();
    },
  });
  return (
    <SheetModal
      visible={visible}
      onClose={save.isPending ? undefined : onClose}
      testID="waiting-add-sheet"
    >
      <View style={styles.head}>
        <AppText
          variant="headline"
          accessibilityRole="header"
          style={styles.flex}
        >
          {t("waiter.waiting.addTitle")}
        </AppText>
        <IconButton
          icon="close"
          accessibilityLabel={t("waiter.waiting.close")}
          onPress={onClose}
          disabled={save.isPending}
        />
      </View>
      <AppTextField
        label={t("waiter.waiting.name")}
        placeholder={t("waiter.waiting.namePlaceholder")}
        value={name}
        onChangeText={setName}
        maxLength={NAME_MAX}
        autoCapitalize="words"
        testID="waiting-name"
      />
      <View style={styles.sizeRow}>
        <AppText variant="bodyLg" bold>
          {t("waiter.waiting.size")}
        </AppText>
        <QuantityStepper
          value={size}
          min={1}
          max={30}
          onChange={setSize}
          testID="waiting-size"
        />
      </View>
      <AppTextField
        label={t("waiter.waiting.notes")}
        value={notes}
        onChangeText={setNotes}
        testID="waiting-notes"
      />
      {save.isError && (
        <AppText
          variant="body"
          bold
          color={colors.dangerText}
          accessibilityRole="alert"
        >
          {errorMessage(save.error)}
        </AppText>
      )}
      <AppButton
        label={t("waiter.waiting.save")}
        size="lg"
        fullWidth
        loading={save.isPending}
        disabled={!name.trim()}
        onPress={() => save.mutate()}
        testID="waiting-save"
      />
    </SheetModal>
  );
}

function AssignSheet({
  entry,
  onClose,
}: {
  entry: WaitingEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("mobile");
  const router = useRouter();
  const qc = useQueryClient();
  const resources = useResources();
  const groups = freeTablesByGroup(resources.data ?? []);
  const [error, setError] = useState<string | null>(null);
  const [poolPick, setPoolPick] = useState<Resource | null>(null);
  const assign = useMutation({
    mutationFn: (resourceId: string) => assignWaiting(entry!.id, resourceId),
    onSuccess: ({ ticket }) => {
      haptic.success();
      void qc.invalidateQueries({ queryKey: qk.waiting });
      void qc.invalidateQueries({ queryKey: qk.resources });
      onClose();
      router.push(`/ticket/${ticket.id}/menu`);
    },
    onError: (e) => {
      const err = toApiError(e);
      void qc.invalidateQueries({ queryKey: qk.resources });
      setError(
        err.code === "BAR_CLOSED"
          ? t("waiter.waiting.closed")
          : err.code === "RESOURCE_OCCUPIED"
            ? t("waiter.waiting.occupied")
            : err.code === "RESOURCE_INACTIVE"
              ? t("waiter.waiting.inactive")
              : errorMessage(err),
      );
    },
  });
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <>
      <SheetModal
        visible={!!entry}
        onClose={assign.isPending ? undefined : close}
        testID="waiting-assign-sheet"
      >
        <View style={styles.head}>
          <AppText
            variant="headline"
            accessibilityRole="header"
            style={styles.flex}
            numberOfLines={2}
          >
            {t("waiter.waiting.assignTitle", { name: entry?.party_name ?? "" })}
          </AppText>
          <IconButton
            icon="close"
            accessibilityLabel={t("waiter.waiting.close")}
            onPress={close}
            disabled={assign.isPending}
          />
        </View>
        {!!error && (
          <AppText
            variant="body"
            bold
            color={colors.dangerText}
            accessibilityRole="alert"
            testID="waiting-assign-error"
          >
            {error}
          </AppText>
        )}
        {groups.length === 0 ? (
          <AppText
            variant="body"
            color={colors.textSecondary}
            testID="waiting-no-free"
          >
            {t("waiter.waiting.noFree")}
          </AppText>
        ) : (
          groups.map((g) => (
            <View key={g.group} style={styles.group}>
              <AppText variant="label" bold color={colors.textSecondary}>
                {t(`waiter.waiting.group${g.group}`)}
              </AppText>
              <View style={styles.grid}>
                {g.tables.map((r) => (
                  <Pressable
                    key={r.id}
                    testID={`assign-table-${r.code}`}
                    accessibilityRole="button"
                    accessibilityLabel={r.code}
                    disabled={assign.isPending}
                    onPress={() => {
                      setError(null);
                      // Assigning a pool table starts billing time: confirm first.
                      if (r.type === "POOL_TABLE") setPoolPick(r);
                      else assign.mutate(r.id);
                    }}
                    style={({ pressed }) => [
                      styles.table,
                      { opacity: assign.isPending ? 0.5 : pressed ? 0.8 : 1 },
                    ]}
                  >
                    <AppText variant="title">{r.code}</AppText>
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </SheetModal>
      <ConfirmDialog
        visible={!!poolPick}
        title={poolPick?.code ?? ""}
        message={t("waiter.waiting.poolStart")}
        confirmLabel={t("waiter.waiting.assign")}
        cancelLabel={t("cancel")}
        onCancel={() => setPoolPick(null)}
        onConfirm={() => {
          if (poolPick) assign.mutate(poolPick.id);
          setPoolPick(null);
        }}
        testID="waiting-pool-dialog"
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.s4, gap: spacing.s2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
    padding: spacing.s3,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    minHeight: touch.primary,
  },
  rowText: { flex: 1, gap: 2 },
  chip: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.s2,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.infoTint,
  },
  headRight: { flexDirection: "row", alignItems: "center", gap: spacing.s2 },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.s2 },
  sizeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  group: { gap: spacing.s2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.s2 },
  table: {
    minWidth: 76,
    minHeight: touch.primary,
    paddingHorizontal: spacing.s3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.tableFreeBorder,
    backgroundColor: colors.tableFreeBg,
  },
});
