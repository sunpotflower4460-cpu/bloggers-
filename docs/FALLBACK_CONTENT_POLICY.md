# Fallback AI Content Quality Policy

Blog GardenのAI failoverは可用性を上げますが、primaryとfallbackで文章品質・事実確認の癖・タイトル感覚が同一とは限りません。

そのため、**AIが返せたこと**と**そのまま読者へ公開してよいこと**を分離します。

## 既定: `review`

```env
AI_FALLBACK_CONTENT_POLICY=review
```

この安全既定では:

- 企画・内部判断はfallbackを利用できます。
- 最終記事本文をprimaryが生成した場合、ブログ本来の`publishMode`を維持します。
- `auto`ブログでも、最終記事本文をfallbackが生成した場合は**その記事だけ`review`/draftへ降格**します。
- 元から`review`のブログは常にreviewのままです。
- 公開済み記事のheadline refresh案をfallbackが生成した場合、**その更新は自動適用しません**。
- fallback使用・強制draft化はrun logへAI route metadataとともに記録します。

これにより、primary障害中も調査・企画・下書き作成は継続できますが、品質差が未知のモデルが読者向け公開面を無条件に変更しません。

## 明示opt-in: `allow-auto`

fallbackモデルを実運用で十分検証し、primaryと同等に自動公開してよいと判断した場合のみ:

```env
AI_FALLBACK_CONTENT_POLICY=allow-auto
```

この設定ではfallback生成の最終記事もブログ本来の`publishMode=auto`を維持し、fallback生成の既存記事改善案も他の安全条件を満たせば適用できます。

`/diagnostics`は`allow-auto`をwarningとして表示します。これは設定ミスではなく、品質リスクを明示的に受け入れた運用であることを見える化するためです。

## 変わらない安全ゲート

`allow-auto`にしても、次は解除されません。

- AI日次call/token予算
- bounded failover（最大1 fallback）
- primary circuit breaker
- source allowlist
- duplicate-title guard
- prompt-injection対策
- generated HTML sanitizer
- platform updateのrevision/collision safety
- blog単位execution lease

## 推奨運用

新しいfallback provider/modelを追加した直後は`review`のまま運用し、実際のdraftを人間が複数確認してから`allow-auto`を検討してください。モデル名を変更した場合も同様に再確認する方が安全です。
