import { useState } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { EMPTY_KINDLE_CONFIG, useKindleConfig, useSaveKindleConfig } from "@/hooks/useKindle";
import type { KindleConfig } from "@/lib/bindings";
import { isDesktopRuntime } from "@/lib/ipc";
import { Actions, Feedback, Row, SettingsGroup, Unsaved } from "@/features/settings/section";
import { SecretsNotice } from "@/features/settings/SecretsNotice";

/** No SMTP in the browser: the whole section is desktop-only, like backup. */
export function KindleSection() {
  const config = useKindleConfig();
  if (!isDesktopRuntime) return null;
  // A config sealed by another build cannot be opened here: debug uses a fixed
  // key, release the keychain's. Hiding the form on that error left no way to
  // replace the unreadable config — and no target for the rail's jump.
  if (!config.data && !config.isError) return null;
  return (
    <KindleForm
      key={config.dataUpdatedAt}
      initial={config.data ?? EMPTY_KINDLE_CONFIG}
      loadError={config.isError ? String(config.error) : null}
    />
  );
}

function KindleForm({ initial, loadError }: { initial: KindleConfig; loadError: string | null }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const save = useSaveKindleConfig();
  const dirty = (Object.keys(initial) as (keyof KindleConfig)[]).some(
    (key) => draft[key] !== initial[key],
  );

  const set = (field: keyof KindleConfig) => (value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  return (
    <SettingsGroup
      id="kindle"
      icon={PaperPlaneTilt}
      title="发送到 Kindle"
      description="把书架上的 EPUB 作为附件发到 Kindle 个人文档邮箱，由亚马逊转成 Kindle 格式。单封总大小上限 50 MB；发件邮箱需先加入「已批准的个人文档电子邮件地址」。"
      badge={<Unsaved dirty={dirty} />}
    >
      {loadError && (
        <div className="px-5 py-3.5">
          <Feedback
            status={{
              tone: "bad",
              text: `读取已保存配置失败：${loadError}。请重新填写并保存，覆盖这份打不开的配置。`,
            }}
          />
        </div>
      )}
      <Row label="SMTP 服务器" hint="例如 smtp.qq.com；只支持 465（TLS）与 587（STARTTLS）。">
        <div className="flex w-full gap-2">
          <GlassInput
            value={draft.smtpHost}
            onChange={(event) => set("smtpHost")(event.target.value)}
            placeholder="smtp.qq.com"
            aria-label="SMTP 服务器"
            spellCheck={false}
          />
          <GlassInput
            value={String(draft.smtpPort)}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, smtpPort: Number(event.target.value) }))
            }
            inputMode="numeric"
            aria-label="SMTP 端口"
            className="w-20"
          />
        </div>
      </Row>
      <Row label="发件邮箱" hint="必须和上一步加入亚马逊信任列表的地址一致。">
        <GlassInput
          value={draft.username}
          onChange={(event) => set("username")(event.target.value)}
          placeholder="reader@example.com"
          aria-label="发件邮箱"
          autoComplete="off"
          spellCheck={false}
        />
      </Row>
      <Row label="授权码" hint="邮箱服务商提供的应用专用密码，不是登录密码；用系统钥匙串加密保存。">
        <GlassInput
          type="password"
          value={draft.password}
          onChange={(event) => set("password")(event.target.value)}
          aria-label="授权码"
          autoComplete="off"
        />
      </Row>
      <Row
        label="Kindle 邮箱"
        hint="管理内容与设备 → 偏好设置 → 个人文档设置里查看。中国区个人文档服务已停止，请使用非中国区账户。"
      >
        <GlassInput
          value={draft.kindleEmail}
          onChange={(event) => set("kindleEmail")(event.target.value)}
          placeholder="reader@kindle.com"
          aria-label="Kindle 邮箱"
          autoComplete="off"
          spellCheck={false}
        />
      </Row>

      <Actions>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>

      <SecretsNotice />
    </SettingsGroup>
  );
}
