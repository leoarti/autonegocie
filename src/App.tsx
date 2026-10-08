import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";

import Index from "./pages/Index";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import NewCharge from "./pages/NewCharge";
import ChargeHistory from "./pages/ChargeHistory";
import Payment from "./pages/Payment";
import Checkout from "./pages/Checkout";
import PaymentDirect from "./pages/PaymentDirect";
import PaymentPix from "./pages/PaymentPix";
import PaymentCard from "./pages/PaymentCard";
import CheckoutPix from "./pages/CheckoutPix";
import ThankYou from "./pages/ThankYou";
import PayoutAccounts from "./pages/PayoutAccounts";
import MessageTemplates from "./pages/MessageTemplates";
import MessageQueue from "./pages/MessageQueue";
import CreateAdmin from "./pages/CreateAdmin";
import NotFound from "./pages/NotFound";
import Simulator from "./pages/Simulator";
import Autopay from "./pages/Autopay";

// Admin pages
import UserManagement from "./pages/admin/UserManagement";
import RefundManagement from "./pages/admin/RefundManagement";
import RecurrenceManagement from "./pages/admin/RecurrenceManagement";
import CheckoutNew from "./pages/admin/CheckoutNew";
import CheckoutHistory from "./pages/admin/CheckoutHistory";
import Reports from "./pages/admin/Reports";
import CompanySettings from "./pages/admin/CompanySettings";
import CompanyManagement from "./pages/admin/CompanyManagement";
import ConnectivityTest from "./pages/admin/ConnectivityTest";
import { useState } from "react";
import { firebaseConfigError } from "@/integrations/firebase/config";

const App = () => {
  const [queryClient] = useState(() => new QueryClient());

  if (firebaseConfigError) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-lg space-y-3">
          <h1 className="text-2xl font-semibold">Firebase não configurado</h1>
          <p className="text-muted-foreground">{firebaseConfigError}</p>
          <p className="text-sm text-muted-foreground">
            No console do Firebase, crie um app Web e copie apiKey, authDomain, projectId e appId.
            O mesmo projectId precisa estar em .firebaserc.
          </p>
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/payment" element={<Payment />} />
                <Route path="/checkout/:id" element={<Checkout />} />
                <Route path="/payment-direct/:id" element={<PaymentDirect />} />
                <Route path="/payment-pix/:id" element={<PaymentPix />} />
                <Route path="/payment-card/:id" element={<PaymentCard />} />
                <Route path="/checkout-pix/:id" element={<CheckoutPix />} />
                <Route path="/thank-you" element={<ThankYou />} />
                <Route path="/simulador" element={<Simulator />} />
                <Route path="/autopay" element={<Autopay />} />
                
                <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                <Route path="/new-charge" element={<ProtectedRoute><NewCharge /></ProtectedRoute>} />
                <Route path="/charges" element={<ProtectedRoute><ChargeHistory /></ProtectedRoute>} />
                <Route path="/payout-accounts" element={<ProtectedRoute><PayoutAccounts /></ProtectedRoute>} />
                <Route path="/message-templates" element={<ProtectedRoute><MessageTemplates /></ProtectedRoute>} />
                <Route path="/message-queue" element={<ProtectedRoute><MessageQueue /></ProtectedRoute>} />
                <Route path="/create-admin" element={<ProtectedRoute requiredRole="admin"><CreateAdmin /></ProtectedRoute>} />
                
                <Route path="/admin/users" element={<ProtectedRoute requiredRole="admin"><UserManagement /></ProtectedRoute>} />
                <Route path="/admin/companies" element={<ProtectedRoute requiredRole="admin"><CompanyManagement /></ProtectedRoute>} />
                
                <Route path="/admin/refunds" element={<ProtectedRoute requiredRole="admin"><RefundManagement /></ProtectedRoute>} />
                <Route path="/admin/recurrences" element={<ProtectedRoute requiredRole="admin"><RecurrenceManagement /></ProtectedRoute>} />
                <Route path="/admin/checkout/new" element={<ProtectedRoute requiredRole="admin"><CheckoutNew /></ProtectedRoute>} />
                <Route path="/admin/checkout/history" element={<ProtectedRoute requiredRole="admin"><CheckoutHistory /></ProtectedRoute>} />
                <Route path="/admin/reports" element={<ProtectedRoute requiredRole="admin"><Reports /></ProtectedRoute>} />
                <Route path="/admin/settings" element={<ProtectedRoute requiredRole="admin"><CompanySettings /></ProtectedRoute>} />
                <Route path="/admin/connectivity-test" element={<ProtectedRoute requiredRole="admin"><ConnectivityTest /></ProtectedRoute>} />
                
                <Route path="*" element={<NotFound />} />
              </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
};

export default App;
