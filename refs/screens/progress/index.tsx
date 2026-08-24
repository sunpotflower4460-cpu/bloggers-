/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-015（処理に時間がかかる）
 */
const ProgressScreen = () => {
  const percent = 42
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>処理中 {percent}%</p>
      <div style={{ height: 'var(--sp-1)', background: 'var(--surface)', borderRadius: 'var(--radius-s)' }}>
        <div
          style={{
            height: '100%',
            width: `${percent}%`,
            background: 'var(--accent)',
            borderRadius: 'var(--radius-s)',
            transitionProperty: 'width',
            transitionDuration: 'var(--dur)',
            transitionTimingFunction: 'var(--ease)',
          }}
        />
      </div>
      <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
        画面を離れても、完了後に結果を確認できます
      </p>
    </div>
  )
}

export default ProgressScreen
