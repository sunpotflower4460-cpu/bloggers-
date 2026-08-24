/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-017（オフライン）
 */
const OfflineScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>オフラインです</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
      一部の機能は使用できません。復帰後に自動で同期されます
    </p>
  </div>
)

export default OfflineScreen
