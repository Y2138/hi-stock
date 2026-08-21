<script setup lang="ts">
// 数据与备份（/datasync）：安全初始化包 + 完整私有数据卷。
// 数据卷恢复为破坏性操作：列表内两步确认 + 显式警告文案，确认后调 POST /api/volume/restore
// （默认 data_only=true 恢复到当前库，服务端强制 manifest 校验，差异清单原样展示）。
import { onMounted, ref } from "vue";
import { apiClient } from "../api/client";
import type {
  PortableExportResult,
  PortablePackage,
  VolumeExportResult,
  VolumeRestoreResult,
  VolumeSnapshot,
} from "../api/types";
import StateBlock from "../components/StateBlock.vue";
import { useResource } from "../composables/useResource";
import { useUiRefresh } from "../composables/useUiRefresh";
import { appMessage } from "../stores/message";
import { fmtNum, fmtTime, shortHash } from "../utils/format";

// ---- 数据卷：快照列表 / 导出 / 恢复 ----
const volume = useResource<VolumeSnapshot[]>(() =>
  apiClient.get<VolumeSnapshot[]>("/api/volume/snapshots"),
);
const portable = useResource<PortablePackage[]>(() => apiClient.get<PortablePackage[]>("/api/volume/portable"));
const portableExport = ref<{ running: boolean; message: string | null; error: string | null }>({
  running: false,
  message: null,
  error: null,
});
const exportState = ref<{ running: boolean; message: string | null; error: string | null }>({
  running: false,
  message: null,
  error: null,
});
/** 恢复两步确认：待确认的快照 id；结果/错误按快照 id 展示 */
const confirmingRestore = ref<string | null>(null);
const restoreState = ref<Record<string, { running: boolean; result: VolumeRestoreResult | null; error: string | null }>>({});

async function runExport(): Promise<void> {
  exportState.value = { running: true, message: null, error: null };
  const r = await apiClient.post<VolumeExportResult>("/api/volume/export", {});
  if (r.ok) {
    exportState.value = {
      running: false,
      message: `导出完成：${r.data.path}（${r.data.tool.mode} 模式${r.data.pruned > 0 ? `，滚动清理 ${r.data.pruned} 份` : ""}）`,
      error: null,
    };
    appMessage.success(exportState.value.message!, { title: "数据卷导出完成" });
    await volume.reload();
  } else {
    exportState.value = { running: false, message: null, error: `导出失败（${r.code}）：${r.message}` };
  }
}

async function runPortableExport(): Promise<void> {
  portableExport.value = { running: true, message: null, error: null };
  const result = await apiClient.post<PortableExportResult>("/api/volume/portable/export", {});
  if (result.ok) {
    portableExport.value = {
      running: false,
      message: `固定资产包已生成：${result.data.path}（策略版本 ${result.data.strategy_revision_count}，定时任务 ${result.data.job_definition_count}）`,
      error: null,
    };
    appMessage.success(portableExport.value.message!, { title: "初始化包已生成" });
    await portable.reload();
  } else {
    portableExport.value = { running: false, message: null, error: `${result.code}：${result.message}` };
  }
}

async function runRestore(snap: VolumeSnapshot): Promise<void> {
  if (confirmingRestore.value !== snap.id) {
    confirmingRestore.value = snap.id;
    return;
  }
  confirmingRestore.value = null;
  restoreState.value[snap.id] = { running: true, result: null, error: null };
  const r = await apiClient.post<VolumeRestoreResult>("/api/volume/restore", { path: snap.path });
  if (r.ok) {
    restoreState.value[snap.id] = { running: false, result: r.data, error: null };
    if (r.data.verified) appMessage.success("数据卷恢复完成，manifest 校验通过");
    else appMessage.warning("数据卷已恢复，但校验存在差异，请查看差异清单", { title: "恢复结果需检查" });
    await volume.reload();
  } else {
    restoreState.value[snap.id] = { running: false, result: null, error: `${r.code}：${r.message}` };
  }
}

function reloadDataPackages(): void {
  volume.reload();
  portable.reload();
}

useUiRefresh("datasync", reloadDataPackages);
onMounted(reloadDataPackages);
</script>

<template>
  <section>
    <div class="page-head">
      <h1>数据与备份</h1>
      <div class="sub">固定资产包用于新机器，完整数据卷用于私有灾备</div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="card-title">
        📦 可移植固定资产包
        <button class="btn volume-export-btn primary" type="button" :disabled="portableExport.running" @click="runPortableExport">
          {{ portableExport.running ? "生成中…" : "生成固定资产包" }}
        </button>
      </div>
      <p class="card-desc">用于新机器空库初始化；只包含当前策略、演进摘要、定时任务定义及提示词。API Key、持仓/流水、标的池、行情和运行历史全部排除。</p>
      <p class="card-desc">恢复命令：<code>npm run portable:restore -- &lt;包路径&gt; --target &lt;空数据库连接串&gt;</code></p>
      <p v-if="portableExport.message" class="volume-msg ok-text num">{{ portableExport.message }}</p>
      <p v-else-if="portableExport.error" class="volume-msg bad-text">{{ portableExport.error }}</p>
      <StateBlock :loading="portable.loading.value" :error="portable.error.value" :empty="(portable.data.value?.length ?? 0) === 0" empty-text="暂无初始化包" @retry="portable.reload">
        <div class="table-wrap portable-table">
          <table class="data-table">
            <thead><tr><th>导出时间</th><th>路径</th><th>迁移</th><th>策略版本</th><th>定时任务</th><th>提示词版本</th><th>大小</th><th>SHA-256</th></tr></thead>
            <tbody>
              <tr v-for="item in portable.data.value" :key="item.path">
                <td class="num">{{ fmtTime(item.exported_at) }}</td>
                <td class="num path-cell">{{ item.path }}</td>
                <td class="num">v{{ item.migration_max }}</td>
                <td class="num">{{ fmtNum(item.strategy_revision_count) }}</td>
                <td class="num">{{ item.job_definition_count }}</td>
                <td class="num">{{ item.prompt_revision_count }}</td>
                <td class="num">{{ (item.size_bytes / 1024 / 1024).toFixed(1) }} MB</td>
                <td class="num" :title="item.payload_sha256">{{ shortHash(item.payload_sha256) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </div>

    <!-- 数据卷区块：快照列表 + 导出 + 恢复（两步确认） -->
    <div class="card" style="margin-top: 16px">
      <div class="card-title">
        💾 数据卷
        <button class="btn volume-export-btn" type="button" :disabled="exportState.running" @click="runExport">
          {{ exportState.running ? "导出中…" : "立即导出快照" }}
        </button>
      </div>
      <p class="card-desc" style="margin-bottom: 8px">
        pg_dump 全量快照 + manifest 校验，滚动保留最近 14 份；恢复默认 data_only 模式写入当前库并强制对账。
      </p>
      <p v-if="exportState.message" class="volume-msg ok-text num">{{ exportState.message }}</p>
      <p v-else-if="exportState.error" class="volume-msg bad-text">{{ exportState.error }}</p>
      <StateBlock
        :loading="volume.loading.value"
        :error="volume.error.value"
        :empty="(volume.data.value?.length ?? 0) === 0"
        empty-text="暂无快照，点击「立即导出快照」创建第一份"
        :skeleton-rows="3"
        @retry="volume.reload"
      >
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>导出时间</th>
                <th>类型</th>
                <th>路径</th>
                <th>数据库</th>
                <th>表数</th>
                <th>行情覆盖</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="snap in volume.data.value" :key="snap.id">
                <tr>
                  <td class="num">{{ fmtTime(snap.manifest.exported_at) ?? fmtTime(snap.created_at) }}</td>
                  <td><span class="badge" :class="{ accent: snap.kind === 'manual' }">{{ snap.kind === "manual" ? "手动" : "定时" }}</span></td>
                  <td class="num path-cell">{{ snap.path }}</td>
                  <td class="num">{{ snap.manifest.database }}</td>
                  <td class="num">{{ snap.manifest.table_count }}</td>
                  <td class="num coverage-cell">
                    <span v-for="(cov, freq) in snap.manifest.market_bar_coverage" :key="freq">
                      {{ freq }}: {{ cov.min ?? "-" }}~{{ cov.max ?? "-" }}
                    </span>
                  </td>
                  <td>
                    <button
                      class="btn mini-btn danger"
                      type="button"
                      :disabled="restoreState[snap.id]?.running"
                      @click="runRestore(snap)"
                    >
                      {{ restoreState[snap.id]?.running
                        ? "恢复中…"
                        : confirmingRestore === snap.id
                          ? "再次点击确认恢复"
                          : "恢复" }}
                    </button>
                  </td>
                </tr>
                <tr v-if="confirmingRestore === snap.id" class="restore-warn-row">
                  <td colspan="7">
                    ⚠ 恢复将以该快照数据覆盖当前库（data_only 模式，先迁移建 schema 再灌数据），
                    当前库中快照之后的新增数据会被快照内容覆盖。确认无误请再次点击「再次点击确认恢复」。
                  </td>
                </tr>
                <tr v-if="restoreState[snap.id]?.result" class="restore-result-row">
                  <td colspan="7">
                    <span :class="restoreState[snap.id]!.result!.verified ? 'ok-text' : 'bad-text'">
                      {{ restoreState[snap.id]!.result!.verified
                        ? `恢复完成且 manifest 校验通过（${restoreState[snap.id]!.result!.tool.mode} 模式）`
                        : "恢复后校验存在差异：" }}
                    </span>
                    <ul v-if="restoreState[snap.id]!.result!.diffs.length > 0" class="diff-list">
                      <li v-for="d in restoreState[snap.id]!.result!.diffs" :key="d">{{ d }}</li>
                    </ul>
                  </td>
                </tr>
                <tr v-if="restoreState[snap.id]?.error" class="restore-result-row">
                  <td colspan="7">
                    <span class="bad-text">恢复失败：{{ restoreState[snap.id]!.error }}</span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </div>

  </section>
</template>

<style scoped>
.table-wrap {
  max-height: 64vh;
  overflow: auto;
}

.path-cell {
  max-width: 320px;
  word-break: break-all;
}

.volume-export-btn {
  margin-left: auto;
  padding: 4px 12px;
  font-size: 12px;
}

.volume-msg {
  margin: 6px 0;
  font-size: 12.5px;
}

.ok-text {
  color: var(--ok);
}

.bad-text {
  color: var(--bad);
}

.coverage-cell span {
  display: inline-block;
  margin-right: 8px;
  font-size: 11.5px;
  color: var(--ink-soft);
}

.mini-btn {
  padding: 2px 10px;
  font-size: 11.5px;
}

.mini-btn.danger {
  color: var(--bad);
}

.mini-btn.danger:hover {
  border-color: var(--bad);
}

.restore-warn-row td {
  background: var(--up-bg);
  color: var(--up);
  font-size: 12px;
}

.restore-result-row td {
  background: var(--paper-deep);
  font-size: 12px;
}

.diff-list {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--bad);
}
</style>
