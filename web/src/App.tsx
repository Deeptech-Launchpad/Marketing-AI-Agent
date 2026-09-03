import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { CompanyProvider } from './lib/companyContext'
import { AppShell } from './components/shell/AppShell'
import { SignIn } from './components/shell/SignIn'
import { AgentMark } from './components/agent/AgentMark'
import { CommandCentre } from './engines/CommandCentre'
import { ProspectDiscovery } from './engines/ProspectDiscovery'
import { Enrichment } from './engines/Enrichment'
import { IntentSignals } from './engines/IntentSignals'
import { DecisionMakers } from './engines/DecisionMakers'
import { WebsiteAudit } from './engines/WebsiteAudit'
import { AuditReport } from './engines/AuditReport'
import { Approval } from './engines/Approval'
import { Workbench } from './engines/Workbench'
import { Outreach } from './engines/Outreach'
import { Engagement } from './engines/Engagement'
import { IntentScoring } from './engines/IntentScoring'
import { Qualification } from './engines/Qualification'
import { CrmSync } from './engines/CrmSync'

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}

/**
 * Nothing renders until the platform knows who is asking.
 *
 * Permissions come from the backend, so the interface never guesses what a
 * viewer may do — it asks, and hides what the answer excludes.
 */
function Gate() {
  const { principal, loading } = useAuth()

  if (loading) {
    return (
      <div className="boot">
        <AgentMark state="thinking" size={44} />
        <p>Connecting to the Marketing AI platform…</p>
      </div>
    )
  }

  if (!principal) return <SignIn />

  return (
    <CompanyProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<CommandCentre />} />
          <Route path="/prospect" element={<ProspectDiscovery />} />
          <Route path="/enrichment" element={<Enrichment />} />
          <Route path="/intent" element={<IntentSignals />} />
          <Route path="/decision-makers" element={<DecisionMakers />} />
          <Route path="/audit" element={<WebsiteAudit />} />
          <Route path="/report" element={<AuditReport />} />
          <Route path="/approval" element={<Approval />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/engagement" element={<Engagement />} />
          <Route path="/scoring" element={<IntentScoring />} />
          <Route path="/qualification" element={<Qualification />} />
          <Route path="/crm" element={<CrmSync />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </CompanyProvider>
  )
}
