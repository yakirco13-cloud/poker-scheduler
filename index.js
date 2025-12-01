import Layout from "./Layout.jsx";

import MyGroups from "./MyGroups";

import GroupHome from "./GroupHome";

import NextGame from "./NextGame";

import Stats from "./Stats";

import JoinGroup from "./JoinGroup";

import GroupSettings from "./GroupSettings";

import GameSession from "./GameSession";

import UserProfile from "./UserProfile";

import Groups from "./Groups";

import GamesCalendar from "./GamesCalendar";

import Welcome from "./Welcome";

import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const PAGES = {
    
    MyGroups: MyGroups,
    
    GroupHome: GroupHome,
    
    NextGame: NextGame,
    
    Stats: Stats,
    
    JoinGroup: JoinGroup,
    
    GroupSettings: GroupSettings,
    
    GameSession: GameSession,
    
    UserProfile: UserProfile,
    
    Groups: Groups,
    
    GamesCalendar: GamesCalendar,

    Welcome: Welcome,
    
}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    let urlLastPart = url.split('/').pop();
    if (urlLastPart.includes('?')) {
        urlLastPart = urlLastPart.split('?')[0];
    }

    const pageName = Object.keys(PAGES).find(page => page.toLowerCase() === urlLastPart.toLowerCase());
    return pageName || Object.keys(PAGES)[0];
}

// Protected route wrapper that checks onboarding
function ProtectedRoute({ children }) {
    const { data: user, isLoading } = useQuery({
        queryKey: ['currentUser'],
        queryFn: () => base44.auth.me(),
        staleTime: 5 * 60 * 1000,
    });

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-emerald-950 via-slate-900 to-slate-950 flex items-center justify-center">
                <div className="text-center">
                    <div className="relative w-16 h-16 mx-auto mb-4">
                        <div className="absolute inset-0 border-4 border-emerald-600/20 rounded-full"></div>
                        <div className="absolute inset-0 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin"></div>
                    </div>
                    <p className="text-emerald-400 text-base font-medium">טוען...</p>
                </div>
            </div>
        );
    }

    // If user hasn't completed onboarding, redirect to Welcome
    if (user && !user.onboardingComplete && !user.displayName) {
        return <Navigate to="/Welcome" replace />;
    }

    return children;
}

// Create a wrapper component that uses useLocation inside the Router context
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    const isWelcomePage = location.pathname.toLowerCase() === '/welcome';
    
    // Welcome page renders without Layout
    if (isWelcomePage) {
        return <Welcome />;
    }

    return (
        <ProtectedRoute>
            <Layout currentPageName={currentPage}>
                <Routes>            
                    
                        <Route path="/" element={<MyGroups />} />
                    
                    
                    <Route path="/MyGroups" element={<MyGroups />} />
                    
                    <Route path="/GroupHome" element={<GroupHome />} />
                    
                    <Route path="/NextGame" element={<NextGame />} />
                    
                    <Route path="/Stats" element={<Stats />} />
                    
                    <Route path="/JoinGroup" element={<JoinGroup />} />
                    
                    <Route path="/GroupSettings" element={<GroupSettings />} />
                    
                    <Route path="/GameSession" element={<GameSession />} />
                    
                    <Route path="/UserProfile" element={<UserProfile />} />
                    
                    <Route path="/Groups" element={<Groups />} />
                    
                    <Route path="/GamesCalendar" element={<GamesCalendar />} />

                    <Route path="/Welcome" element={<Welcome />} />
                    
                </Routes>
            </Layout>
        </ProtectedRoute>
    );
}

export default function Pages() {
    return (
        <Router>
            <Routes>
                <Route path="/Welcome" element={<Welcome />} />
                <Route path="/*" element={<PagesContent />} />
            </Routes>
        </Router>
    );
}