/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-006（タブ/スタックの判断）/ C-030（画面遷移のアニメーション）
 */
import { useState } from 'react'

const tabs = ['一覧', '検索'] // 並列に選ぶ情報 → タブ
const stackSteps = ['入力', '確認', '完了'] // 順番に進む情報 → スタック

const NavigationScreen = () => {
  const [tab, setTab] = useState(tabs[0])
  const [step, setStep] = useState(0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
      <section>
        <h2 style={{ fontSize: 'var(--fs-2)', color: 'var(--text-muted)' }}>並列 → タブ</h2>
        <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                fontSize: 'var(--fs-2)',
                color: t === tab ? 'var(--text)' : 'var(--text-muted)',
                background: 'none',
                border: 'none',
                borderBottom: t === tab ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 'var(--fs-2)', color: 'var(--text-muted)' }}>順序 → スタック</h2>
        <div
          key={step}
          style={{
            padding: 'var(--sp-3)',
            fontSize: 'var(--fs-3)',
            color: 'var(--text)',
            transitionProperty: 'opacity, transform',
            transitionDuration: 'var(--dur)',
            transitionTimingFunction: 'var(--ease)',
          }}
        >
          {stackSteps[step]}
        </div>
        <button
          onClick={() => setStep((s) => (s + 1) % stackSteps.length)}
          style={{ fontSize: 'var(--fs-2)', color: 'var(--accent)', background: 'none', border: 'none' }}
        >
          次へ進む
        </button>
      </section>
    </div>
  )
}

export default NavigationScreen
