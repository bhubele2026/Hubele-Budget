import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="p-6 flex justify-between items-center max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="H2 Budget" className="w-10 h-10 rounded-md shadow-sm" />
          <span className="font-serif font-bold text-2xl tracking-tight text-primary">H2 Budget</span>
        </div>
        <div className="flex gap-4">
          <Link href="/sign-in" className="text-sm font-medium text-foreground flex items-center px-4 hover:text-primary transition-colors">Log In</Link>
          <Link href="/sign-up" className="bg-primary text-primary-foreground text-sm font-medium px-5 py-2 rounded-md hover:bg-primary/90 transition-colors shadow-sm">Get Started</Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 py-20 max-w-4xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-serif font-bold text-foreground tracking-tight leading-tight mb-6">
          The meticulous ledger <br className="hidden md:block"/> for family finances.
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mb-10 leading-relaxed">
          Outgrown your spreadsheet? H2 provides a confident, calm, and information-rich environment to track every dollar, manage allowances, and crush debts.
        </p>
        <Link href="/sign-up" className="bg-primary text-primary-foreground text-lg font-medium px-8 py-4 rounded-md hover:bg-primary/90 transition-colors shadow-md">
          Start Your Ledger
        </Link>
      </main>
    </div>
  );
}
