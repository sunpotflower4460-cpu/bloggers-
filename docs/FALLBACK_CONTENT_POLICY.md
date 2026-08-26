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

## 要レビューキュー

fallbackによってdraftへ降格された記事は統合HPの`fallback生成 · 要レビュー`へ集約します。

各項目には次を表示します。

- ブログ / platform
- 記事タイトルと外部draftへのリンク
- fallback provider label / model
- primary失敗後のfallbackか、circuit open中の直接fallbackか
- 作成日時

レビュー後は単なる「確認済み」ではなく、次のどちらかを記録します。

- `quality-ok`: このdraftは人間レビュー上、品質面で問題なし
- `needs-improvement`: 自動公開に任せるには改善が必要

## provider/model別の人間品質シグナル

品質評価はprovider/model単位で集計します。

統合HPには評価件数、品質OK件数、要改善件数、OK率を表示します。

判定表示は意図的に保守的です。

- 10件未満: `サンプル不足`
- 10件以上かつOK率90%以上: `高評価傾向`
- 10件以上かつOK率70%以上90%未満: `評価が混在`
- 10件以上かつOK率70%未満: `要改善傾向`

これらは**観測・判断材料**です。`高評価傾向`になってもBlog Garden自身が`AI_FALLBACK_CONTENT_POLICY=allow-auto`へ変更することはありません。

人間の品質評価は、検索CTRやPVのような読者反応とは別の信号です。文章の正確さ、読みやすさ、ブランド適合、違和感など、人間がdraftを確認した結果として扱います。

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

新しいfallback provider/modelを追加した直後は`review`のまま運用し、実際のdraftを人間が複数確認してください。少なくとも10件未満の評価はサンプル不足として扱い、モデル名やprovider構成を変更した場合も新しい組み合わせとして再確認する方が安全です。
