'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useAuth';
import { useLocalStorage } from './useLocalStorage';
import { GUEST_STORAGE_KEY, MIGRATION_IGNORE_KEY, getNextStatus } from '@/lib/constants';
import { calculateStats, getCurrentPosition } from '@/lib/calculations';
import type { CalendarConfig, WeekEntry, WeekStatus } from '@/types/calendar';
import { createClient } from '@/lib/supabase/client';

export function useCalendar() {
    const { user, loading: authLoading } = useAuth();
    const supabase = createClient();
    const lastLoadedUserId = useRef<string | null>(null);
    const hasInitialLoaded = useRef(false);

    // Local Storage for Guest Mode
    const [guestData, setGuestData, removeGuestData] = useLocalStorage<any>(GUEST_STORAGE_KEY, null);

    // State
    const [config, setConfig] = useState<CalendarConfig>({ birthYear: 2000, lifeExpectancy: 80 });
    const [weeks, setWeeks] = useState<WeekEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [isMigrating, setIsMigrating] = useState(false);
    const [showMigrationPrompt, setShowMigrationPrompt] = useState(false);
    const [neverAskMigration, setNeverAskMigration] = useLocalStorage<boolean>(MIGRATION_IGNORE_KEY, false);

    // Derived State
    const stats = calculateStats(config.birthYear, config.lifeExpectancy);
    const currentPosition = getCurrentPosition(config.birthYear);

    // Load Data
    useEffect(() => {
        if (authLoading) return;

        const loadData = async () => {
            if (user) {
                // If we already loaded data for this user, don't show loading spinner again
                if (lastLoadedUserId.current === user.id) {
                    return;
                }

                setLoading(true);
                // Fetch from Supabase
                try {
                    let { data: calendar, error: calError } = await supabase
                        .from('calendars')
                        .select('*')
                        .eq('user_id', user.id)
                        .maybeSingle();

                    if (calError && calError.code !== 'PGRST116') {
                        console.error('Error fetching calendar:', calError);
                    }

                    // If no calendar exists, create one with default values
                    if (!calendar) {
                        const { data: newCalendar, error: createError } = await supabase
                            .from('calendars')
                            .insert({
                                user_id: user.id,
                                birth_year: 2000,
                                life_expectancy: 80,
                            })
                            .select()
                            .single();

                        if (createError) {
                            console.error('Error creating calendar:', createError);
                        } else {
                            calendar = newCalendar;
                        }
                    }

                    if (calendar) {
                        setConfig({
                            birthYear: calendar.birth_year,
                            lifeExpectancy: calendar.life_expectancy,
                        });

                        const { data: weekEntries, error: weeksError } = await supabase
                            .from('week_entries')
                            .select('*')
                            .eq('calendar_id', calendar.id);

                        if (weeksError) {
                            // Error fetching weeks
                        } else {
                            const validatedWeeks = Array.isArray(weekEntries) ? weekEntries.map(w => ({
                                yearIndex: w.year_index,
                                monthIndex: w.month_index,
                                weekIndex: w.week_index,
                                status: w.status as WeekStatus,
                            })) : [];
                            setWeeks(validatedWeeks);
                        }
                    }

                    // Show migration prompt if user has guest data and hasn't ignored it
                    if (guestData && !neverAskMigration) {
                        const hasWeeks = guestData.weeks && guestData.weeks.length > 0;
                        const hasModifiedConfig = guestData.birthYear !== 2000 || guestData.lifeExpectancy !== 80;

                        if (hasWeeks || hasModifiedConfig) {
                            setShowMigrationPrompt(true);
                        }
                    }
                    lastLoadedUserId.current = user.id;
                    hasInitialLoaded.current = true;
                } catch (err) {
                    // Unexpected error loading data
                }
            } else {
                // Guest mode
                // Only load guest data if we haven't loaded it yet or if user logged out
                if (lastLoadedUserId.current !== null || !hasInitialLoaded.current) {
                    if (guestData) {
                        setConfig({
                            birthYear: guestData.birthYear || 2000,
                            lifeExpectancy: guestData.lifeExpectancy || 80,
                        });
                        setWeeks(Array.isArray(guestData.weeks) ? guestData.weeks : []);
                    }
                    lastLoadedUserId.current = null;
                    hasInitialLoaded.current = true;
                }
            }
            setLoading(false);
        };

        loadData();
    }, [user?.id, authLoading]);

    const syncGuestData = async () => {
        if (!user || !guestData || isMigrating) return;
        setIsMigrating(true);

        try {
            // 1. Upsert Calendar
            const { data: calendar, error: calError } = await supabase
                .from('calendars')
                .upsert({
                    user_id: user.id,
                    birth_year: guestData.birthYear || 2000,
                    life_expectancy: guestData.lifeExpectancy || 80,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' })
                .select()
                .single();

            if (calError) throw calError;

            // 2. Sync Week Entries
            if (calendar) {
                // Delete existing weeks first for a clean overwrite
                await supabase
                    .from('week_entries')
                    .delete()
                    .eq('calendar_id', calendar.id);

                if (guestData.weeks && guestData.weeks.length > 0) {
                    const weekEntries = guestData.weeks.map((w: any) => ({
                        calendar_id: calendar.id,
                        year_index: w.yearIndex,
                        month_index: w.monthIndex,
                        week_index: w.weekIndex,
                        status: w.status,
                    }));

                    const { error: weeksError } = await supabase
                        .from('week_entries')
                        .insert(weekEntries);

                    if (weeksError) throw weeksError;
                }
            }

            // 3. Update local state
            setConfig({
                birthYear: calendar.birth_year,
                lifeExpectancy: calendar.life_expectancy,
            });
            setWeeks(Array.isArray(guestData.weeks) ? guestData.weeks : []);
            setShowMigrationPrompt(false);

        } catch (err) {
            // Migration failed
        } finally {
            setIsMigrating(false);
        }
    };

    const dismissMigrationPrompt = () => {
        setShowMigrationPrompt(false);
    };

    const updateConfig = async (newConfig: Partial<CalendarConfig>) => {
        const updated = { ...config, ...newConfig };
        setConfig(updated);

        if (user) {
            try {
                const { error } = await supabase
                    .from('calendars')
                    .upsert({
                        user_id: user.id,
                        birth_year: updated.birthYear,
                        life_expectancy: updated.lifeExpectancy,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'user_id' });

                if (error) throw error;
            } catch (err) {
                // Error updating config
            }
        } else {
            setGuestData({
                ...guestData,
                birthYear: updated.birthYear,
                lifeExpectancy: updated.lifeExpectancy,
            });
        }
    };

    const toggleWeekStatus = useCallback(async (yearIndex: number, monthIndex: number, weekIndex: number) => {
        setWeeks(prevWeeks => {
            const existingWeek = prevWeeks.find(
                w => w.yearIndex === yearIndex && w.monthIndex === monthIndex && w.weekIndex === weekIndex
            );

            const currentStatus = existingWeek?.status || 'gray';
            const isPast =
                yearIndex < currentPosition.year ||
                (yearIndex === currentPosition.year && monthIndex < currentPosition.month) ||
                (yearIndex === currentPosition.year && monthIndex === currentPosition.month && weekIndex < currentPosition.week);


            const nextStatus = getNextStatus(currentStatus, isPast);


            let newWeeks;
            if (existingWeek) {
                newWeeks = prevWeeks.map(w =>
                    (w.yearIndex === yearIndex && w.monthIndex === monthIndex && w.weekIndex === weekIndex)
                        ? { ...w, status: nextStatus }
                        : w
                );
            } else {
                newWeeks = [...prevWeeks, { yearIndex, monthIndex, weekIndex, status: nextStatus }];
            }

            // Persist
            if (user) {
                // Fire and forget persistence
                (async () => {
                    try {
                        const { data: calendar } = await supabase
                            .from('calendars')
                            .select('id')
                            .eq('user_id', user.id)
                            .maybeSingle();

                        if (calendar) {
                            await supabase
                                .from('week_entries')
                                .upsert({
                                    calendar_id: calendar.id,
                                    year_index: yearIndex,
                                    month_index: monthIndex,
                                    week_index: weekIndex,
                                    status: nextStatus,
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: 'calendar_id,year_index,month_index,week_index' });
                        }
                    } catch (err) {
                        // Error toggling week status
                    }
                })();
            } else {
                setGuestData((prevGuest: any) => ({
                    ...prevGuest,
                    weeks: newWeeks,
                }));
            }

            return newWeeks;
        });
    }, [user, supabase, currentPosition, setGuestData]);

    const getWeekStatus = useCallback((yearIndex: number, monthIndex: number, weekIndex: number): WeekStatus => {
        const week = weeks.find(
            w => w.yearIndex === yearIndex && w.monthIndex === monthIndex && w.weekIndex === weekIndex
        );
        return week?.status || 'gray';
    }, [weeks]);

    const clearCalendar = async () => {
        const defaultConfig = { birthYear: 2000, lifeExpectancy: 80 };
        setConfig(defaultConfig);
        setWeeks([]);

        if (user) {
            try {
                // 1. Update Calendar Config
                const { error: calError } = await supabase
                    .from('calendars')
                    .upsert({
                        user_id: user.id,
                        birth_year: defaultConfig.birthYear,
                        life_expectancy: defaultConfig.lifeExpectancy,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'user_id' });

                if (calError) throw calError;

                // 2. Delete all week entries
                const { data: calendar } = await supabase
                    .from('calendars')
                    .select('id')
                    .eq('user_id', user.id)
                    .maybeSingle();

                if (calendar) {
                    const { error: weeksError } = await supabase
                        .from('week_entries')
                        .delete()
                        .eq('calendar_id', calendar.id);

                    if (weeksError) throw weeksError;
                }
            } catch (err) {
                // Error clearing calendar
            }
        } else {
            setGuestData({
                ...defaultConfig,
                weeks: [],
            });
        }
    };

    return {
        config,
        weeks,
        stats,
        currentPosition,
        loading: loading || authLoading,
        showMigrationPrompt,
        neverAskMigration,
        updateConfig,
        toggleWeekStatus,
        getWeekStatus,
        clearCalendar,
        syncGuestData,
        dismissMigrationPrompt,
        setNeverAskMigration,
    };
}
